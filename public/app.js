const homeScreen = document.getElementById('homeScreen');
const roomScreen = document.getElementById('roomScreen');
const connectionPill = document.getElementById('connectionPill');
const createRoomBtn = document.getElementById('createRoomBtn');
const createRoomHint = document.getElementById('createRoomHint');
const joinRoomInput = document.getElementById('joinRoomInput');
const joinPinInput = document.getElementById('joinPinInput');
const checkRoomBtn = document.getElementById('checkRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomLookupChip = document.getElementById('roomLookupChip');
const lookupMessage = document.getElementById('lookupMessage');
const roomTitle = document.getElementById('roomTitle');
const roomNumberValue = document.getElementById('roomNumberValue');
const roomPinValue = document.getElementById('roomPinValue');
const occupancyChip = document.getElementById('occupancyChip');
const copyInviteBtn = document.getElementById('copyInviteBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const toggleMuteBtn = document.getElementById('toggleMuteBtn');
const callStatusText = document.getElementById('callStatusText');
const voiceStatusChip = document.getElementById('voiceStatusChip');
const callStateBox = document.getElementById('callStateBox');
const chatMessages = document.getElementById('chatMessages');
const emptyChatState = document.getElementById('emptyChatState');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const remoteAudio = document.getElementById('remoteAudio');
const toast = document.getElementById('toast');

const RTC_CONFIGURATION = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const state = {
  socket: null,
  socketConnected: false,
  roomNumber: null,
  pin: null,
  myPeerId: null,
  currentTargetPeerId: null,
  role: null,
  occupancy: 0,
  localStream: null,
  peerConnection: null,
  isMuted: false,
  heartbeatInterval: null,
  lastLookupController: null
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2600);
}

function setConnectionState(type, label) {
  connectionPill.textContent = label;
  connectionPill.className = `connection-pill ${type}`;
}

function setLookupChip(type, label) {
  roomLookupChip.textContent = label;
  roomLookupChip.className = `status-chip ${type}`;
}

function setVoiceState(type, label, detailText) {
  voiceStatusChip.textContent = label;
  voiceStatusChip.className = `status-chip ${type}`;
  if (detailText) callStatusText.textContent = detailText;
}

function switchScreen(screenName) {
  homeScreen.classList.toggle('active', screenName === 'home');
  roomScreen.classList.toggle('active', screenName === 'room');
}

function validateRoomAndPin(roomNumber, pin) {
  if (!/^\d+$/.test(String(roomNumber || '').trim())) {
    throw new Error('Ingresa un número de sala válido.');
  }
  if (!/^\d{4}$/.test(String(pin || '').trim())) {
    throw new Error('El PIN debe tener exactamente 4 dígitos.');
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Ocurrió un error de red.');
  }

  return data;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderMessages(messages = []) {
  chatMessages.innerHTML = '';

  if (!messages.length) {
    chatMessages.appendChild(emptyChatState);
    return;
  }

  messages.forEach(appendMessage);
}

function appendMessage(message) {
  if (emptyChatState.isConnected) {
    emptyChatState.remove();
  }

  const isSelf = message.senderId === state.myPeerId;
  const wrapper = document.createElement('article');
  wrapper.className = `chat-message ${isSelf ? 'self' : 'peer'}`;

  const textNode = document.createElement('div');
  textNode.textContent = message.text;

  const metaNode = document.createElement('div');
  metaNode.className = 'meta';
  metaNode.textContent = `${isSelf ? 'Tú' : 'Invitado'} · ${formatTime(message.timestamp)}`;

  wrapper.appendChild(textNode);
  wrapper.appendChild(metaNode);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function ensureLocalStream() {
  if (state.localStream) return state.localStream;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    state.localStream = stream;
    state.isMuted = false;
    toggleMuteBtn.textContent = 'Silenciar micrófono';
    setVoiceState('neutral', 'Audio preparado', 'Micrófono listo. Esperando conexión con la otra persona.');
    return stream;
  } catch (error) {
    console.error(error);
    setVoiceState(
      'warning',
      'Sin micrófono',
      'No se pudo acceder al micrófono. Puedes permanecer en el chat, pero la llamada no transmitirá tu voz.'
    );
    showToast('No se pudo acceder al micrófono. Revisa permisos del navegador.');
    return null;
  }
}

function destroyPeerConnection() {
  if (state.peerConnection) {
    state.peerConnection.onicecandidate = null;
    state.peerConnection.ontrack = null;
    state.peerConnection.onconnectionstatechange = null;
    state.peerConnection.close();
    state.peerConnection = null;
  }

  state.currentTargetPeerId = null;
  remoteAudio.srcObject = null;
}

async function ensurePeerConnection(targetPeerId) {
  if (state.peerConnection && state.currentTargetPeerId === targetPeerId) {
    return state.peerConnection;
  }

  destroyPeerConnection();
  state.currentTargetPeerId = targetPeerId;

  const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
  state.peerConnection = peerConnection;

  const localStream = await ensureLocalStream();
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || !state.socket || !state.currentTargetPeerId) return;
    state.socket.emit('webrtc:ice-candidate', {
      targetPeerId: state.currentTargetPeerId,
      candidate: event.candidate
    });
  };

  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(() => {});
  };

  peerConnection.onconnectionstatechange = () => {
    const { connectionState } = peerConnection;

    if (connectionState === 'connected') {
      setVoiceState('success', 'En llamada', 'La llamada de voz está activa.');
      callStateBox.textContent = 'Llamada establecida. Puedes hablar en tiempo real y usar el chat al mismo tiempo.';
      return;
    }

    if (['connecting', 'new'].includes(connectionState)) {
      setVoiceState('warning', 'Conectando', 'Conectando audio en tiempo real…');
      callStateBox.textContent = 'La segunda persona ya entró. Estamos negociando la conexión de audio.';
      return;
    }

    if (['disconnected', 'failed'].includes(connectionState)) {
      setVoiceState('error', 'Sin audio', 'La conexión de audio se interrumpió.');
      callStateBox.textContent = 'La llamada se desconectó. Si la otra persona sigue dentro, la app intentará restablecer la conexión cuando vuelva a entrar.';
      return;
    }

    if (connectionState === 'closed') {
      setVoiceState('neutral', 'Sin llamada', 'La llamada terminó.');
      callStateBox.textContent = 'La llamada terminó. Puedes esperar a otra persona o salir de la sala.';
    }
  };

  return peerConnection;
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatInterval = setInterval(() => {
    if (state.socket && state.socket.connected && state.roomNumber) {
      state.socket.emit('room:heartbeat');
    }
  }, 15000);
}

function stopHeartbeat() {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
}

function updateRoomHeader() {
  roomTitle.textContent = `Sala #${state.roomNumber}`;
  roomNumberValue.textContent = state.roomNumber || '—';
  roomPinValue.textContent = state.pin || '—';
  occupancyChip.textContent = `${state.occupancy} / 2`;

  if (state.occupancy === 2) {
    occupancyChip.className = 'status-chip success';
  } else if (state.occupancy === 1) {
    occupancyChip.className = 'status-chip warning';
  } else {
    occupancyChip.className = 'status-chip neutral';
  }
}

function resetHomeLookup() {
  setLookupChip('neutral', 'Sin verificar');
  lookupMessage.textContent = 'La app mostrará si la sala existe, está ocupada o llena.';
}

async function lookupRoomStatus() {
  const roomNumber = String(joinRoomInput.value || '').trim();

  if (!roomNumber) {
    resetHomeLookup();
    return;
  }

  if (!/^\d+$/.test(roomNumber)) {
    setLookupChip('error', 'Inválida');
    lookupMessage.textContent = 'El número de sala debe ser numérico.';
    return;
  }

  try {
    if (state.lastLookupController) state.lastLookupController.abort();
    state.lastLookupController = new AbortController();

    setLookupChip('neutral', 'Consultando');
    lookupMessage.textContent = 'Verificando disponibilidad de la sala…';

    const result = await fetchJson(`/api/rooms/${roomNumber}/status`, {
      signal: state.lastLookupController.signal
    });

    const labelMap = {
      available: 'Disponible',
      occupied: '1 dentro',
      full: 'Llena'
    };

    const typeMap = {
      available: 'success',
      occupied: 'warning',
      full: 'error'
    };

    setLookupChip(typeMap[result.status], labelMap[result.status]);
    lookupMessage.textContent = `Sala #${result.roomNumber} · ${result.occupancy}/2 personas dentro.`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    setLookupChip('error', 'No existe');
    lookupMessage.textContent = error.message;
  }
}

function debounce(fn, wait = 350) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

function initSocket() {
  if (state.socket) return state.socket;

  const socket = io({
    transports: ['websocket', 'polling']
  });

  state.socket = socket;
  setConnectionState('connecting', 'Conectando…');

  socket.on('connect', () => {
    state.socketConnected = true;
    setConnectionState('connected', 'En línea');

    // Reintento simple de reconexión al cuarto actual cuando el socket se recupera.
    if (state.roomNumber && state.pin) {
      socket.emit('room:join', { roomNumber: state.roomNumber, pin: state.pin }, (response) => {
        if (!response?.ok) {
          showToast(response?.error || 'No fue posible recuperar la sala actual.');
          hardResetRoomState();
          return;
        }

        showToast('Conexión recuperada. Reingresando a la sala…');
      });
    }
  });

  socket.on('disconnect', () => {
    state.socketConnected = false;
    setConnectionState('disconnected', 'Sin conexión');
    destroyPeerConnection();
    setVoiceState('error', 'Sin conexión', 'Se perdió la conexión con el servidor.');
  });

  socket.on('room:joined', async (payload) => {
    state.roomNumber = payload.roomNumber;
    state.pin = payload.pinHint;
    state.myPeerId = payload.participantId;
    state.role = payload.role;
    state.occupancy = payload.occupancy;

    updateRoomHeader();
    renderMessages(payload.messages || []);
    switchScreen('room');
    startHeartbeat();
    await ensureLocalStream();
  });

  socket.on('room:state', (payload) => {
    state.occupancy = payload.occupancy;
    updateRoomHeader();
  });

  socket.on('peer:waiting', ({ message }) => {
    setVoiceState('warning', 'Esperando', message);
    callStateBox.textContent = message;
  });

  socket.on('peer:ready', async ({ peerId }) => {
    try {
      const peerConnection = await ensurePeerConnection(peerId);
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false
      });
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', {
        targetPeerId: peerId,
        description: peerConnection.localDescription
      });
    } catch (error) {
      console.error(error);
      showToast('No fue posible iniciar la llamada.');
    }
  });

  socket.on('webrtc:offer', async ({ fromPeerId, description }) => {
    try {
      const peerConnection = await ensurePeerConnection(fromPeerId);
      await peerConnection.setRemoteDescription(description);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc:answer', {
        targetPeerId: fromPeerId,
        description: peerConnection.localDescription
      });
    } catch (error) {
      console.error(error);
      showToast('No fue posible responder la llamada.');
    }
  });

  socket.on('webrtc:answer', async ({ description }) => {
    try {
      if (!state.peerConnection) return;
      await state.peerConnection.setRemoteDescription(description);
    } catch (error) {
      console.error(error);
      showToast('No fue posible completar la conexión de audio.');
    }
  });

  socket.on('webrtc:ice-candidate', async ({ candidate }) => {
    try {
      if (!state.peerConnection) return;
      await state.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error(error);
    }
  });

  socket.on('chat:message', (message) => {
    appendMessage(message);
  });

  socket.on('peer:left', () => {
    destroyPeerConnection();
    setVoiceState('warning', 'Esperando', 'La otra persona salió o perdió la conexión.');
    callStateBox.textContent = 'La otra persona ya no está en la sala. Puedes esperar a alguien más o abandonar la sala.';
  });

  socket.on('room:expired', ({ message }) => {
    showToast(message || 'La sala expiró por inactividad.');
    hardResetRoomState();
  });

  return socket;
}

function hardResetRoomState() {
  stopHeartbeat();
  destroyPeerConnection();

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }

  state.roomNumber = null;
  state.pin = null;
  state.myPeerId = null;
  state.currentTargetPeerId = null;
  state.role = null;
  state.occupancy = 0;
  state.isMuted = false;
  chatInput.value = '';
  toggleMuteBtn.textContent = 'Silenciar micrófono';
  renderMessages([]);
  updateRoomHeader();
  setVoiceState('neutral', 'Sin llamada', 'Tu sala aún no tiene una llamada activa.');
  callStateBox.textContent = 'Tu sala está lista. Cuando entre la segunda persona, la llamada se conectará automáticamente.';
  switchScreen('home');
}

async function joinRoom(roomNumber, pin) {
  try {
    validateRoomAndPin(roomNumber, pin);
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;

    const socket = initSocket();
    await ensureLocalStream();

    socket.emit('room:join', { roomNumber, pin }, (response) => {
      createRoomBtn.disabled = false;
      joinRoomBtn.disabled = false;

      if (!response?.ok) {
        showToast(response?.error || 'No fue posible entrar a la sala.');
        return;
      }

      showToast('Ingreso correcto. Entrando a la sala…');
    });
  } catch (error) {
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
    showToast(error.message);
  }
}

createRoomBtn.addEventListener('click', async () => {
  try {
    createRoomBtn.disabled = true;
    createRoomHint.textContent = 'Creando sala privada…';

    const result = await fetchJson('/api/rooms/auto-create', {
      method: 'POST',
      body: JSON.stringify({})
    });

    createRoomHint.textContent = `Sala #${result.roomNumber} creada con PIN ${result.pin}.`;
    await joinRoom(String(result.roomNumber), result.pin);
  } catch (error) {
    createRoomHint.textContent = error.message;
    showToast(error.message);
    createRoomBtn.disabled = false;
  }
});

checkRoomBtn.addEventListener('click', lookupRoomStatus);
joinRoomBtn.addEventListener('click', () => joinRoom(joinRoomInput.value, joinPinInput.value));
joinRoomInput.addEventListener('input', debounce(lookupRoomStatus, 350));
joinPinInput.addEventListener('input', () => {
  joinPinInput.value = String(joinPinInput.value || '')
    .replace(/\D/g, '')
    .slice(0, 4);
});
joinRoomInput.addEventListener('input', () => {
  joinRoomInput.value = String(joinRoomInput.value || '').replace(/\D/g, '');
});

copyInviteBtn.addEventListener('click', async () => {
  const text = `Since · Sala #${state.roomNumber} · PIN ${state.pin}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Acceso copiado al portapapeles.');
  } catch (error) {
    showToast(`Comparte manualmente: ${text}`);
  }
});

leaveRoomBtn.addEventListener('click', () => {
  if (state.socket && state.roomNumber) {
    state.socket.emit('room:leave');
  }
  hardResetRoomState();
  showToast('Saliste de la sala.');
});

toggleMuteBtn.addEventListener('click', async () => {
  const stream = await ensureLocalStream();
  if (!stream) return;

  state.isMuted = !state.isMuted;
  stream.getAudioTracks().forEach((track) => {
    track.enabled = !state.isMuted;
  });

  toggleMuteBtn.textContent = state.isMuted ? 'Activar micrófono' : 'Silenciar micrófono';
  showToast(state.isMuted ? 'Micrófono silenciado.' : 'Micrófono activado.');
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = String(chatInput.value || '').trim();
  if (!text) return;
  if (!state.socket || !state.roomNumber) {
    showToast('Debes estar dentro de una sala para usar el chat.');
    return;
  }

  state.socket.emit('chat:send', { text }, (response) => {
    if (!response?.ok) {
      showToast(response?.error || 'No fue posible enviar el mensaje.');
      return;
    }
    chatInput.value = '';
  });
});

window.addEventListener('beforeunload', () => {
  if (state.socket && state.roomNumber) {
    state.socket.emit('room:leave');
  }
});

window.addEventListener('load', () => {
  initSocket();
  resetHomeLookup();
  setVoiceState('neutral', 'Sin llamada', 'Tu sala aún no tiene una llamada activa.');
  updateRoomHeader();
});
