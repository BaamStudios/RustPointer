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
    modeButtons: Array.from(document.querySelectorAll('.modes button'))
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
    mode: 'sender'
  };

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
      setPeerStatus(true);
    };
    dc.onclose = () => {
      console.log('[dc] close');
      setPeerStatus(false);
    };
    dc.onerror = (e) => console.warn('[dc] error', e);
    dc.onmessage = (evt) => {
      let payload;
      try { payload = JSON.parse(evt.data); }
      catch { return; }
      if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return;
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

    let ws;
    try { ws = new WebSocket(url); }
    catch (err) {
      console.warn('[ws] connect failed:', err.message);
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      setWsStatus(true);
      wsSend({ type: 'join', roomId });
    };

    ws.onclose = () => {
      setWsStatus(false);
      tearDownPeer();
    };

    ws.onerror = (e) => {
      console.warn('[ws] error', e);
    };

    ws.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); }
      catch { return; }

      if (msg.type === 'joined') {
        console.log(`[ws] joined ${msg.roomId} (${msg.peerCount} peers)`);
        if (msg.peerCount === 2) {
          // Wir sind der zweite – wir initiieren das Offer
          startCall().catch((err) => console.warn('startCall failed:', err.message));
        }
      } else if (msg.type === 'peer-joined') {
        // Wir warten auf Offer vom Newcomer? Nein: der Newcomer initiiert.
        console.log('[ws] peer joined:', msg.peerId);
      } else if (msg.type === 'peer-left') {
        console.log('[ws] peer left:', msg.peerId);
        tearDownPeer();
      } else if (msg.type === 'offer') {
        await handleOffer(msg).catch((err) => console.warn('offer failed:', err.message));
      } else if (msg.type === 'answer') {
        await handleAnswer(msg).catch((err) => console.warn('answer failed:', err.message));
      } else if (msg.type === 'ice') {
        await handleIce(msg).catch((err) => console.warn('ice failed:', err.message));
      } else if (msg.type === 'error') {
        console.warn('[signal] error:', msg.message);
      }
    };
  }

  function sendCursor(payload) {
    if (!state.dc || state.dc.readyState !== 'open') return;
    try {
      state.dc.send(JSON.stringify(payload));
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
  els.disconnectBtn.addEventListener('click', () => tearDown());

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

  refreshState();
  loadWindows();
})();
