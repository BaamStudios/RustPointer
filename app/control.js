'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    server: $('server'),
    room: $('room'),
    connectBtn: $('connectBtn'),
    disconnectBtn: $('disconnectBtn'),
    wsStatus: $('wsStatus'),
    peerStatus: $('peerStatus'),
    presenterStatus: $('presenterStatus'),
    presenterToggle: $('presenterToggle'),
    targetTitle: $('targetTitle'),
    applyTitleBtn: $('applyTitleBtn'),
    windowSelect: $('windowSelect'),
    refreshWindowsBtn: $('refreshWindowsBtn'),
    boundsStatus: $('boundsStatus'),
    modeButtons: Array.from(document.querySelectorAll('.modes button')),
    peerList: $('peerList'),
    peerCount: $('peerCount'),
    logBox: $('logBox'),
    clearLogBtn: $('clearLogBtn'),
    sendRate: $('sendRate'),
    recvRate: $('recvRate'),
    sendTotal: $('sendTotal'),
    recvTotal: $('recvTotal')
  };

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const state = {
    ws: null,
    pc: null,
    dc: null,
    role: null,           // 'caller' or 'callee'
    peerConnected: false,
    wsConnected: false,
    mode: 'sender',
    selfPeerId: null,
    roomId: null,
    peers: new Set(),     // alle peerIds im Raum (inkl. self)
    sendCount: 0,
    recvCount: 0,
    lastSendPressed: null,
    lastRecvPressed: null
  };

  const rateState = {
    sendInWindow: 0,
    recvInWindow: 0
  };

  const LOG_MAX_LINES = 200;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowTs() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function logLine(kind, text) {
    const line = document.createElement('div');
    line.className = `l-${kind}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = nowTs();
    line.appendChild(ts);
    line.appendChild(document.createTextNode(text));
    els.logBox.appendChild(line);
    while (els.logBox.childElementCount > LOG_MAX_LINES) {
      els.logBox.removeChild(els.logBox.firstChild);
    }
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }

  function renderPeers() {
    els.peerCount.textContent = String(state.peers.size);
    els.peerList.innerHTML = '';
    if (state.peers.size === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '— nicht verbunden —';
      els.peerList.appendChild(li);
      return;
    }
    const sorted = [...state.peers].sort((a, b) => {
      if (a === state.selfPeerId) return -1;
      if (b === state.selfPeerId) return 1;
      return a.localeCompare(b);
    });
    for (const id of sorted) {
      const li = document.createElement('li');
      const isSelf = id === state.selfPeerId;
      if (isSelf) li.classList.add('self');
      const name = document.createElement('span');
      name.textContent = id;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = isSelf ? 'du' : 'remote';
      li.appendChild(name);
      li.appendChild(tag);
      els.peerList.appendChild(li);
    }
  }

  function resetPeers() {
    state.selfPeerId = null;
    state.roomId = null;
    state.peers.clear();
    renderPeers();
  }

  setInterval(() => {
    els.sendRate.textContent = `${rateState.sendInWindow}/s`;
    els.recvRate.textContent = `${rateState.recvInWindow}/s`;
    rateState.sendInWindow = 0;
    rateState.recvInWindow = 0;
  }, 1000);

  function setBadge(el, text, kind) {
    el.textContent = text;
    el.classList.remove('ok', 'err', 'warn');
    el.classList.add(kind);
  }

  function setWsStatus(connected) {
    state.wsConnected = !!connected;
    if (connected) setBadge(els.wsStatus, 'verbunden', 'ok');
    else setBadge(els.wsStatus, 'getrennt', 'err');
    els.connectBtn.disabled = connected;
    els.disconnectBtn.disabled = !connected;
  }

  function setPeerStatus(connected) {
    state.peerConnected = !!connected;
    if (connected) setBadge(els.peerStatus, 'verbunden (P2P)', 'ok');
    else setBadge(els.peerStatus, 'getrennt', 'err');
    if (window.presenter) {
      window.presenter.reportConnectionStatus({ connected: state.peerConnected });
    }
  }

  function setPresenterStatus(active) {
    if (active) setBadge(els.presenterStatus, 'aktiv', 'warn');
    else setBadge(els.presenterStatus, 'aus', 'err');
  }

  function applyMode(mode) {
    state.mode = mode;
    els.modeButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function tearDownPeer() {
    if (state.dc) {
      try { state.dc.close(); } catch {}
      state.dc = null;
    }
    if (state.pc) {
      try { state.pc.close(); } catch {}
      state.pc = null;
    }
    state.role = null;
    setPeerStatus(false);
  }

  function tearDown() {
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    tearDownPeer();
    setWsStatus(false);
  }

  function wsSend(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify(obj));
  }

  function attachDataChannel(dc) {
    state.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('[dc] open');
      logLine('info', 'DataChannel offen — P2P aktiv');
      setPeerStatus(true);
    };
    dc.onclose = () => {
      console.log('[dc] close');
      logLine('muted', 'DataChannel geschlossen');
      setPeerStatus(false);
    };
    dc.onerror = (e) => {
      console.warn('[dc] error', e);
      logLine('err', `DataChannel-Fehler: ${e && e.message ? e.message : 'unknown'}`);
    };
    dc.onmessage = (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); }
      catch { return; }
      if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return;
      state.recvCount += 1;
      rateState.recvInWindow += 1;
      els.recvTotal.textContent = String(state.recvCount);
      const pressed = !!payload.pressed;
      if (state.lastRecvPressed !== pressed) {
        state.lastRecvPressed = pressed;
        const xy = `(${payload.x.toFixed(3)}, ${payload.y.toFixed(3)})`;
        logLine('recv', pressed ? `← Empfang: Pointer aktiv ${xy}` : `← Empfang: Pointer inaktiv ${xy}`);
      }
      if (window.presenter) window.presenter.sendCursorIncoming(payload);
    };
  }

  function createPeer() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    state.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ type: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      console.log('[pc] state:', st);
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        setPeerStatus(false);
      }
    };
    pc.ondatachannel = (e) => {
      attachDataChannel(e.channel);
    };
    return pc;
  }

  async function startCall() {
    state.role = 'caller';
    const pc = createPeer();
    const dc = pc.createDataChannel('cursor', { ordered: false, maxRetransmits: 0 });
    attachDataChannel(dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', sdp: pc.localDescription });
  }

  async function handleOffer(msg) {
    state.role = 'callee';
    const pc = createPeer();
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'answer', sdp: pc.localDescription });
  }

  async function handleAnswer(msg) {
    if (!state.pc) return;
    await state.pc.setRemoteDescription(msg.sdp);
  }

  async function handleIce(msg) {
    if (!state.pc || !msg.candidate) return;
    try {
      await state.pc.addIceCandidate(msg.candidate);
    } catch (err) {
      console.warn('[ice] addIceCandidate failed:', err.message);
    }
  }

  function connect() {
    const url = els.server.value.trim();
    const roomId = els.room.value.trim();
    if (!url || !roomId) return;

    tearDown();
    logLine('info', `Verbinde zu ${url} · Room "${roomId}"…`);

    let ws;
    try { ws = new WebSocket(url); }
    catch (err) {
      console.warn('[ws] connect failed:', err.message);
      logLine('err', `WS-Verbindung fehlgeschlagen: ${err.message}`);
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      setWsStatus(true);
      logLine('info', 'WebSocket offen — sende join…');
      wsSend({ type: 'join', roomId });
    };

    ws.onclose = () => {
      setWsStatus(false);
      tearDownPeer();
      resetPeers();
      logLine('muted', 'WebSocket geschlossen');
    };

    ws.onerror = (e) => {
      console.warn('[ws] error', e);
      logLine('err', 'WebSocket-Fehler');
    };

    ws.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); }
      catch { return; }

      if (msg.type === 'joined') {
        console.log(`[ws] joined ${msg.roomId} (${msg.peerCount} peers)`);
        state.selfPeerId = msg.peerId;
        state.roomId = msg.roomId;
        state.peers = new Set([msg.peerId, ...(Array.isArray(msg.peers) ? msg.peers : [])]);
        renderPeers();
        logLine('info', `Im Raum "${msg.roomId}" als ${msg.peerId} (${msg.peerCount} Peer${msg.peerCount === 1 ? '' : 's'})`);
        if (msg.peerCount === 2) {
          // Wir sind der zweite – wir initiieren das Offer
          logLine('info', 'Starte WebRTC-Offer…');
          startCall().catch((err) => {
            console.warn('startCall failed:', err.message);
            logLine('err', `Offer fehlgeschlagen: ${err.message}`);
          });
        }
      } else if (msg.type === 'peer-joined') {
        console.log('[ws] peer joined:', msg.peerId);
        state.peers.add(msg.peerId);
        renderPeers();
        logLine('info', `Peer ${msg.peerId} ist beigetreten (${state.peers.size} im Raum)`);
      } else if (msg.type === 'peer-left') {
        console.log('[ws] peer left:', msg.peerId);
        state.peers.delete(msg.peerId);
        renderPeers();
        logLine('muted', `Peer ${msg.peerId} hat verlassen`);
        tearDownPeer();
      } else if (msg.type === 'offer') {
        logLine('info', 'Offer empfangen — sende Answer');
        await handleOffer(msg).catch((err) => {
          console.warn('offer failed:', err.message);
          logLine('err', `Answer fehlgeschlagen: ${err.message}`);
        });
      } else if (msg.type === 'answer') {
        logLine('info', 'Answer empfangen');
        await handleAnswer(msg).catch((err) => {
          console.warn('answer failed:', err.message);
          logLine('err', `Answer-Verarbeitung fehlgeschlagen: ${err.message}`);
        });
      } else if (msg.type === 'ice') {
        await handleIce(msg).catch((err) => console.warn('ice failed:', err.message));
      } else if (msg.type === 'error') {
        console.warn('[signal] error:', msg.message);
        logLine('err', `Signal-Server-Fehler: ${msg.message}`);
      }
    };
  }

  function sendCursor(payload) {
    if (!state.dc || state.dc.readyState !== 'open') return;
    try {
      state.dc.send(JSON.stringify(payload));
      state.sendCount += 1;
      rateState.sendInWindow += 1;
      els.sendTotal.textContent = String(state.sendCount);
      const pressed = !!payload.pressed;
      if (state.lastSendPressed !== pressed) {
        state.lastSendPressed = pressed;
        const xy = `(${payload.x.toFixed(3)}, ${payload.y.toFixed(3)})`;
        logLine('send', pressed ? `→ Sende: Pointer aktiv ${xy}` : `→ Sende: Pointer inaktiv ${xy}`);
      }
    } catch (err) {
      // ignore – DC könnte gerade schließen
    }
  }

  async function loadWindows() {
    if (!window.presenter) return;
    const wins = await window.presenter.listWindows();
    const current = els.windowSelect.value;
    els.windowSelect.innerHTML = '<option value="">— automatisch erkennen —</option>';
    for (const w of wins) {
      const opt = document.createElement('option');
      opt.value = String(w.id);
      const t = (w.title || '').slice(0, 80);
      opt.textContent = `[${w.id}] ${t}`;
      els.windowSelect.appendChild(opt);
    }
    if (current) els.windowSelect.value = current;
  }

  async function refreshState() {
    if (!window.presenter) return;
    const s = await window.presenter.getState();
    applyMode(s.mode);
    setPresenterStatus(s.presenterActive);
    if (s.targetTitle) els.targetTitle.value = s.targetTitle;
    updateBoundsLabel(s.rustDeskBounds);
  }

  function updateBoundsLabel(b) {
    if (!b) {
      els.boundsStatus.textContent = '— kein Fenster gefunden —';
      els.boundsStatus.classList.add('muted');
    } else {
      els.boundsStatus.textContent = `${b.width}×${b.height} @ (${b.x}, ${b.y})`;
    }
  }

  els.connectBtn.addEventListener('click', connect);
  els.disconnectBtn.addEventListener('click', () => {
    logLine('muted', 'Trennung durch Benutzer');
    tearDown();
    resetPeers();
  });

  els.clearLogBtn.addEventListener('click', () => {
    els.logBox.innerHTML = '';
  });

  els.modeButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      applyMode(mode);
      if (window.presenter) await window.presenter.setMode(mode);
    });
  });

  els.presenterToggle.addEventListener('click', async () => {
    if (!window.presenter) return;
    const s = await window.presenter.togglePresenter();
    setPresenterStatus(s.presenterActive);
  });

  els.applyTitleBtn.addEventListener('click', async () => {
    if (!window.presenter) return;
    await window.presenter.setTargetTitle(els.targetTitle.value);
  });

  els.refreshWindowsBtn.addEventListener('click', loadWindows);
  els.windowSelect.addEventListener('change', async () => {
    if (!window.presenter) return;
    const id = els.windowSelect.value || null;
    await window.presenter.setManualWindow(id ? Number(id) : null);
  });

  if (window.presenter) {
    window.presenter.onStateChanged((s) => {
      applyMode(s.mode);
      setPresenterStatus(s.presenterActive);
      updateBoundsLabel(s.rustDeskBounds);
    });
    window.presenter.onCursorSend((payload) => sendCursor(payload));
  }

  async function applyEnvDefaults() {
    if (!window.presenter || !window.presenter.getConfig) return;
    const cfg = await window.presenter.getConfig();
    if (cfg.signalServerUrl) els.server.value = cfg.signalServerUrl;
    if (cfg.roomId) els.room.value = cfg.roomId;
    if (cfg.targetTitle) els.targetTitle.value = cfg.targetTitle;
  }

  applyEnvDefaults().then(() => {
    refreshState();
    loadWindows();
  });
})();
