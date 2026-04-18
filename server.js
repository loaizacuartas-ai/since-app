const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 100);
const ROOM_INACTIVITY_MS = Number(process.env.ROOM_INACTIVITY_MS || 15 * 60 * 1000);
const JOIN_RATE_LIMIT_WINDOW_MS = Number(process.env.JOIN_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000);
const MAX_FAILED_JOIN_ATTEMPTS = Number(process.env.MAX_FAILED_JOIN_ATTEMPTS || 8);
const PIN_SECRET = process.env.PIN_SECRET || 'since-demo-secret-change-me';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

// Memoria efímera del MVP. En producción se migraría a Redis/PostgreSQL.
const rooms = new Map();
const failedJoinAttemptsByIp = new Map();

app.disable('x-powered-by');
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return Date.now();
}

function roomKey(roomNumber) {
  return String(roomNumber);
}

function hashPin(pin) {
  return crypto
    .createHash('sha256')
    .update(`${String(pin)}:${PIN_SECRET}`)
    .digest('hex');
}

function generatePin() {
  return crypto.randomInt(1000, 10000).toString();
}

function sanitizeRoomNumber(input) {
  const value = String(input || '').trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_ROOMS) return null;
  return parsed;
}

function sanitizePin(input) {
  const value = String(input || '').trim();
  if (!/^\d{4}$/.test(value)) return null;
  return value;
}

function getRoomStatus(occupancy) {
  if (occupancy <= 0) return 'available';
  if (occupancy === 1) return 'occupied';
  return 'full';
}

function serializeRoomForStatus(room) {
  const occupancy = room.members.size;
  return {
    roomNumber: room.roomNumber,
    exists: true,
    occupancy,
    capacity: 2,
    status: getRoomStatus(occupancy),
    updatedAt: room.lastActivityAt,
    createdAt: room.createdAt
  };
}

function touchRoom(room) {
  room.lastActivityAt = now();
}

function registerFailedJoinAttempt(ip) {
  const timestamp = now();
  const attempts = failedJoinAttemptsByIp.get(ip) || [];
  const filtered = attempts.filter((entry) => timestamp - entry < JOIN_RATE_LIMIT_WINDOW_MS);
  filtered.push(timestamp);
  failedJoinAttemptsByIp.set(ip, filtered);
}

function clearFailedJoinAttempts(ip) {
  failedJoinAttemptsByIp.delete(ip);
}

function isJoinRateLimited(ip) {
  const attempts = failedJoinAttemptsByIp.get(ip) || [];
  const timestamp = now();
  const filtered = attempts.filter((entry) => timestamp - entry < JOIN_RATE_LIMIT_WINDOW_MS);
  failedJoinAttemptsByIp.set(ip, filtered);
  return filtered.length >= MAX_FAILED_JOIN_ATTEMPTS;
}

function cleanupExpiredRooms() {
  const timestamp = now();

  for (const [key, room] of rooms.entries()) {
    const inactiveFor = timestamp - room.lastActivityAt;
    if (inactiveFor < ROOM_INACTIVITY_MS) continue;

    io.to(room.socketRoomName).emit('room:expired', {
      roomNumber: room.roomNumber,
      message: 'La sala expiró por inactividad.'
    });

    for (const socketId of room.members.keys()) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.leave(room.socketRoomName);
        socket.data.roomNumber = null;
      }
    }

    rooms.delete(key);
  }
}

function findAvailableRoomNumber() {
  cleanupExpiredRooms();

  for (let i = 1; i <= MAX_ROOMS; i += 1) {
    if (!rooms.has(roomKey(i))) {
      return i;
    }
  }

  return null;
}

function createRoom() {
  const availableRoomNumber = findAvailableRoomNumber();
  if (!availableRoomNumber) return null;

  const pin = generatePin();
  const createdAt = now();
  const room = {
    roomNumber: availableRoomNumber,
    pinHash: hashPin(pin),
    members: new Map(),
    messages: [],
    createdAt,
    lastActivityAt: createdAt,
    socketRoomName: `room:${availableRoomNumber}`
  };

  rooms.set(roomKey(availableRoomNumber), room);
  return {
    room,
    plainPin: pin
  };
}

function emitRoomState(room) {
  io.to(room.socketRoomName).emit('room:state', serializeRoomForStatus(room));
}

function relayToTarget(eventName, payload, targetPeerId) {
  const targetSocket = io.sockets.sockets.get(targetPeerId);
  if (!targetSocket) return false;
  io.to(targetPeerId).emit(eventName, payload);
  return true;
}

function leaveRoom(socket, reason = 'left') {
  const joinedRoomNumber = socket.data.roomNumber;
  if (!joinedRoomNumber) return;

  const room = rooms.get(roomKey(joinedRoomNumber));
  socket.leave(`room:${joinedRoomNumber}`);
  socket.data.roomNumber = null;

  if (!room) return;

  room.members.delete(socket.id);
  touchRoom(room);

  io.to(room.socketRoomName).emit('peer:left', {
    peerId: socket.id,
    reason
  });

  if (room.members.size === 0) {
    rooms.delete(roomKey(joinedRoomNumber));
    return;
  }

  emitRoomState(room);
  io.to(room.socketRoomName).emit('peer:waiting', {
    message: 'La otra persona salió. Puedes esperar a alguien más o abandonar la sala.'
  });
}

app.get('/api/health', (req, res) => {
  cleanupExpiredRooms();
  res.json({
    ok: true,
    app: 'Since MVP',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    maxRooms: MAX_ROOMS
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    maxRooms: MAX_ROOMS,
    roomInactivityMs: ROOM_INACTIVITY_MS
  });
});

app.post('/api/rooms/auto-create', (req, res) => {
  cleanupExpiredRooms();
  const created = createRoom();

  if (!created) {
    return res.status(503).json({
      ok: false,
      error: 'No hay salas disponibles en este momento.'
    });
  }

  return res.status(201).json({
    ok: true,
    roomNumber: created.room.roomNumber,
    pin: created.plainPin,
    capacity: 2,
    status: 'available',
    expiresInMs: ROOM_INACTIVITY_MS
  });
});

app.get('/api/rooms/:roomNumber/status', (req, res) => {
  cleanupExpiredRooms();
  const parsedRoomNumber = sanitizeRoomNumber(req.params.roomNumber);

  if (!parsedRoomNumber) {
    return res.status(400).json({
      ok: false,
      exists: false,
      status: 'invalid-room-number',
      error: `El número de sala debe estar entre 1 y ${MAX_ROOMS}.`
    });
  }

  const room = rooms.get(roomKey(parsedRoomNumber));
  if (!room) {
    return res.status(404).json({
      ok: false,
      exists: false,
      status: 'not-found',
      occupancy: 0,
      capacity: 2,
      error: 'La sala no existe o ya expiró.'
    });
  }

  return res.json({
    ok: true,
    ...serializeRoomForStatus(room)
  });
});

io.on('connection', (socket) => {
  socket.data.roomNumber = null;

  socket.on('room:join', (payload, callback = () => {}) => {
    cleanupExpiredRooms();

    const ip = socket.handshake.address || 'unknown-ip';
    if (isJoinRateLimited(ip)) {
      callback({
        ok: false,
        code: 'too-many-attempts',
        error: 'Demasiados intentos fallidos. Espera un momento antes de intentar de nuevo.'
      });
      return;
    }

    const parsedRoomNumber = sanitizeRoomNumber(payload?.roomNumber);
    const pin = sanitizePin(payload?.pin);

    if (!parsedRoomNumber || !pin) {
      registerFailedJoinAttempt(ip);
      callback({
        ok: false,
        code: 'invalid-input',
        error: 'Debes ingresar una sala válida y un PIN de 4 dígitos.'
      });
      return;
    }

    const room = rooms.get(roomKey(parsedRoomNumber));
    if (!room) {
      registerFailedJoinAttempt(ip);
      callback({
        ok: false,
        code: 'room-not-found',
        error: 'La sala no existe, ya expiró o fue liberada.'
      });
      return;
    }

    if (room.pinHash !== hashPin(pin)) {
      registerFailedJoinAttempt(ip);
      callback({
        ok: false,
        code: 'invalid-pin',
        error: 'PIN incorrecto.'
      });
      return;
    }

    if (room.members.size >= 2) {
      callback({
        ok: false,
        code: 'room-full',
        error: 'La sala ya está llena.'
      });
      return;
    }

    if (socket.data.roomNumber) {
      leaveRoom(socket, 'switch-room');
    }

    room.members.set(socket.id, {
      socketId: socket.id,
      joinedAt: now()
    });
    touchRoom(room);

    socket.join(room.socketRoomName);
    socket.data.roomNumber = room.roomNumber;
    clearFailedJoinAttempts(ip);

    const occupancy = room.members.size;
    const role = occupancy === 1 ? 'host' : 'guest';

    callback({ ok: true });
    socket.emit('room:joined', {
      roomNumber: room.roomNumber,
      participantId: socket.id,
      role,
      pinHint: pin,
      occupancy,
      capacity: 2,
      messages: room.messages,
      status: getRoomStatus(occupancy)
    });

    emitRoomState(room);

    if (occupancy === 1) {
      socket.emit('peer:waiting', {
        message: 'Sala creada. Comparte el número y el PIN para que otra persona ingrese.'
      });
      return;
    }

    const peerIds = [...room.members.keys()];
    const existingPeerId = peerIds.find((peerId) => peerId !== socket.id);

    if (existingPeerId) {
      io.to(existingPeerId).emit('peer:ready', {
        peerId: socket.id
      });
      socket.emit('peer:waiting', {
        message: 'Conectando llamada de voz...'
      });
    }
  });

  socket.on('room:heartbeat', () => {
    const joinedRoomNumber = socket.data.roomNumber;
    if (!joinedRoomNumber) return;
    const room = rooms.get(roomKey(joinedRoomNumber));
    if (!room) return;
    touchRoom(room);
  });

  socket.on('chat:send', (payload, callback = () => {}) => {
    const joinedRoomNumber = socket.data.roomNumber;
    if (!joinedRoomNumber) {
      callback({ ok: false, error: 'No estás dentro de una sala.' });
      return;
    }

    const room = rooms.get(roomKey(joinedRoomNumber));
    if (!room) {
      callback({ ok: false, error: 'La sala ya no está disponible.' });
      return;
    }

    const text = String(payload?.text || '').trim();
    if (!text) {
      callback({ ok: false, error: 'El mensaje está vacío.' });
      return;
    }

    const safeText = text.slice(0, 800);
    const message = {
      id: crypto.randomUUID(),
      text: safeText,
      senderId: socket.id,
      timestamp: now()
    };

    room.messages.push(message);
    room.messages = room.messages.slice(-100);
    touchRoom(room);

    io.to(room.socketRoomName).emit('chat:message', message);
    callback({ ok: true });
  });

  socket.on('webrtc:offer', ({ targetPeerId, description }) => {
    const joinedRoomNumber = socket.data.roomNumber;
    if (!joinedRoomNumber || !targetPeerId || !description) return;

    const room = rooms.get(roomKey(joinedRoomNumber));
    if (!room || !room.members.has(targetPeerId)) return;
    touchRoom(room);

    relayToTarget(
      'webrtc:offer',
      {
        fromPeerId: socket.id,
        description
      },
      targetPeerId
    );
  });

  socket.on('webrtc:answer', ({ targetPeerId, description }) => {
    const joinedRoomNumber = socket.data.roomNumber;
    if (!joinedRoomNumber || !targetPeerId || !description) return;

    const room = rooms.get(roomKey(joinedRoomNumber));
    if (!room || !room.members.has(targetPeerId)) return;
    touchRoom(room);

    relayToTarget(
      'webrtc:answer',
      {
        fromPeerId: socket.id,
        description
      },
      targetPeerId
    );
  });

  socket.on('webrtc:ice-candidate', ({ targetPeerId, candidate }) => {
    const joinedRoomNumber = socket.data.roomNumber;
    if (!joinedRoomNumber || !targetPeerId || !candidate) return;

    const room = rooms.get(roomKey(joinedRoomNumber));
    if (!room || !room.members.has(targetPeerId)) return;
    touchRoom(room);

    relayToTarget(
      'webrtc:ice-candidate',
      {
        fromPeerId: socket.id,
        candidate
      },
      targetPeerId
    );
  });

  socket.on('room:leave', () => {
    leaveRoom(socket, 'left');
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, 'disconnect');
  });
});

setInterval(cleanupExpiredRooms, 30 * 1000);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Since MVP running on http://localhost:${PORT}`);
  console.log(`Max rooms: ${MAX_ROOMS}`);
});
