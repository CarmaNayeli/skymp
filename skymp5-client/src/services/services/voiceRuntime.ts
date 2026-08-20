/**
 * The WebRTC half of proximity voice, as source injected into the CEF browser.
 *
 * It lives here as a string rather than in skymp5-front because the front is a
 * separate React bundle that would have to be rebuilt and shipped to every
 * player for each change; injecting it means voice ships inside the ordinary
 * client script update the launcher already performs. The chat window and the
 * Hearthheld menu are built the same way.
 *
 * Audio never touches the game or the server. The server relays only SDP and
 * ICE (see the voiceSignal handler in gamemode.js); the media itself is peer
 * to peer. Every player is on the same NetBird overlay, so host candidates
 * reach each other directly and no STUN or TURN server is required, which also
 * means voice keeps working with no outside internet dependency.
 *
 * The on-screen indicator is drawn as a plain DOM element appended to the
 * document, deliberately NOT as a SkyrimPlatform widget: widgets are replaced
 * wholesale by widgets.set and are shared with chat and the character menu, so
 * anything drawn that way can be erased by an unrelated screen. Voice state has
 * to stay visible whatever else is on screen.
 */
export const VOICE_RUNTIME_JS = `
(function () {
  if (window.hhVoice) { return; }

  // Distances are Skyrim units. Roughly: 250 is a conversational huddle and
  // 2000 is across a market square. Matches CHAT_SAY_RADIUS closely enough
  // that if you can hear someone you can usually also read them.
  var FULL_VOLUME_DISTANCE = 250;
  var MAX_DISTANCE = 2000;
  // Connections are kept a little past the audible range so that pacing back
  // and forth over the boundary does not tear down and rebuild the peer
  // connection repeatedly.
  var DROP_DISTANCE = MAX_DISTANCE * 1.25;

  var state = {
    stream: null,
    micRequested: false,
    micError: null,
    transmitting: false,
    selfActorId: 0,
    peers: {},
  };

  function report(kind, detail) {
    try {
      window.skyrimPlatform.sendMessage('voiceLog', kind + ': ' + detail);
    } catch (e) {}
  }

  function signal(targetActorId, payload) {
    try {
      window.skyrimPlatform.sendMessage(
        'voiceSignal',
        JSON.stringify({ targetActorId: targetActorId, payload: payload }));
    } catch (e) {
      report('error', 'failed to send signal: ' + e);
    }
  }

  // ---------------------------------------------------------------------
  // On-screen indicator.
  // ---------------------------------------------------------------------

  var ui = { root: null, self: null, others: null };

  function ensureUi() {
    if (ui.root || !document.body) { return; }
    var root = document.createElement('div');
    root.id = 'hh-voice';
    root.style.cssText = [
      'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483600',
      // The overlay must never eat clicks meant for the game or for chat.
      'pointer-events:none',
      'font-family:Segoe UI,Arial,sans-serif', 'font-size:13px',
      'color:#f2e9d8', 'text-shadow:0 1px 2px rgba(0,0,0,0.9)',
      'line-height:1.5'
    ].join(';');

    var self = document.createElement('div');
    self.id = 'hh-voice-self';
    var others = document.createElement('div');
    others.id = 'hh-voice-others';

    root.appendChild(self);
    root.appendChild(others);
    document.body.appendChild(root);
    ui.root = root;
    ui.self = self;
    ui.others = others;
  }

  function pill(text, color) {
    return '<span style="display:inline-block;padding:2px 8px;margin:2px 0;' +
      'border-radius:10px;background:rgba(0,0,0,0.55);border:1px solid ' + color + ';' +
      'color:' + color + '">' + text + '</span>';
  }

  function refreshUi() {
    ensureUi();
    if (!ui.root) { return; }

    if (state.micError) {
      ui.self.innerHTML = pill('Microphone unavailable', '#e8737d');
    } else if (state.transmitting) {
      ui.self.innerHTML = pill('&#9679; Speaking', '#7fd98a');
    } else {
      // Shown from the moment voice is running, not just once the microphone
      // has been acquired. The microphone is only asked for on the first press
      // or the first neighbour, so waiting for it meant the prompt was missing
      // exactly when someone needed telling what the key was.
      ui.self.innerHTML = pill('Hold V to talk', '#8a8f98');
    }

    var talking = [];
    Object.keys(state.peers).forEach(function (id) {
      var p = state.peers[id];
      if (p.talking) { talking.push(p.name || ('Player ' + id)); }
    });
    ui.others.innerHTML = talking.map(function (n) {
      return pill('&#9679; ' + n, '#f0d68c');
    }).join('<br>');
  }

  // The game process draws nametags, so it needs to know who is speaking.
  function reportTalkingToGame() {
    var ids = [];
    Object.keys(state.peers).forEach(function (id) {
      if (state.peers[id].talking) { ids.push(Number(id)); }
    });
    try {
      window.skyrimPlatform.sendMessage('voiceState', JSON.stringify({ talking: ids }));
    } catch (e) {}
  }

  function isTyping() {
    try {
      var el = document.activeElement;
      if (!el) { return false; }
      var tag = (el.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
    } catch (e) {
      return false;
    }
  }

  function setPeerTalking(actorId, on) {
    var peer = state.peers[actorId];
    if (!peer || peer.talking === on) { return; }
    peer.talking = on;
    refreshUi();
    reportTalkingToGame();
  }

  // ---------------------------------------------------------------------
  // Microphone and peers.
  // ---------------------------------------------------------------------

  // Asking for the microphone is deferred until the first peer is actually in
  // range. Requesting it at load would light the recording indicator for
  // someone standing alone in the arrival room.
  function ensureMic() {
    if (state.stream || state.micRequested) { return; }
    state.micRequested = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.micError = 'getUserMedia unavailable';
      report('error', 'no getUserMedia in this browser build');
      refreshUi();
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    }).then(function (stream) {
      state.stream = stream;
      // Start muted. Voice is push to talk, and an open mic the moment the
      // permission resolves is how people broadcast things they did not mean
      // to.
      stream.getAudioTracks().forEach(function (t) { t.enabled = state.transmitting; });
      report('info', 'microphone ready');
      // Any peer that connected while we were waiting has no outgoing track
      // yet, so attach to them now.
      Object.keys(state.peers).forEach(function (id) {
        attachLocalTracks(state.peers[id]);
      });
      refreshUi();
    }).catch(function (err) {
      state.micError = String(err);
      report('error', 'microphone denied or unavailable: ' + err);
      refreshUi();
    });
  }

  function attachLocalTracks(peer) {
    if (!state.stream || !peer || !peer.pc || peer.tracksAttached) { return; }
    try {
      state.stream.getAudioTracks().forEach(function (track) {
        peer.pc.addTrack(track, state.stream);
      });
      peer.tracksAttached = true;
    } catch (e) {
      report('error', 'could not attach local audio: ' + e);
    }
  }

  function volumeForDistance(d) {
    if (d <= FULL_VOLUME_DISTANCE) { return 1; }
    if (d >= MAX_DISTANCE) { return 0; }
    var t = (d - FULL_VOLUME_DISTANCE) / (MAX_DISTANCE - FULL_VOLUME_DISTANCE);
    // Squared falloff, so voices fade out over the far half of the range
    // rather than dropping off a cliff at the edge.
    return (1 - t) * (1 - t);
  }

  function createPeer(actorId, name) {
    var pc;
    try {
      // No iceServers on purpose: everyone shares a NetBird overlay network,
      // so host candidates connect directly.
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      report('error', 'RTCPeerConnection unavailable: ' + e);
      return null;
    }

    var audio = document.createElement('audio');
    audio.autoplay = true;
    audio.volume = 0;
    try { document.body.appendChild(audio); } catch (e) {}

    var peer = {
      actorId: actorId,
      name: name || '',
      pc: pc,
      audio: audio,
      // Whoever has the lower id makes the offer. Both sides discover each
      // other on the same tick, so without a fixed rule both would offer at
      // once and the negotiation would collide.
      isCaller: state.selfActorId < actorId,
      tracksAttached: false,
      pendingIce: [],
      haveRemote: false,
      talking: false,
      distance: Infinity
    };

    pc.onicecandidate = function (ev) {
      if (ev.candidate) {
        signal(actorId, { kind: 'ice', candidate: ev.candidate });
      }
    };
    pc.ontrack = function (ev) {
      if (ev.streams && ev.streams[0]) {
        audio.srcObject = ev.streams[0];
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        report('warn', 'connection to ' + actorId + ' failed');
        removePeer(actorId);
      }
      if (pc.connectionState === 'connected' && state.transmitting) {
        // They joined mid-sentence and would otherwise show no indicator
        // until the key was released and pressed again.
        signal(actorId, { kind: 'talking', on: true });
      }
    };

    state.peers[actorId] = peer;
    attachLocalTracks(peer);

    if (peer.isCaller) {
      pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer).then(function () {
          signal(actorId, { kind: 'offer', sdp: pc.localDescription });
        });
      }).catch(function (e) { report('error', 'offer failed: ' + e); });
    }
    return peer;
  }

  function removePeer(actorId) {
    var peer = state.peers[actorId];
    if (!peer) { return; }
    delete state.peers[actorId];
    try { peer.pc.close(); } catch (e) {}
    try {
      peer.audio.srcObject = null;
      if (peer.audio.parentNode) { peer.audio.parentNode.removeChild(peer.audio); }
    } catch (e) {}
    refreshUi();
    reportTalkingToGame();
  }

  function flushPendingIce(peer) {
    if (!peer.haveRemote) { return; }
    var queued = peer.pendingIce;
    peer.pendingIce = [];
    queued.forEach(function (c) {
      peer.pc.addIceCandidate(c).catch(function (e) {
        report('warn', 'late ice rejected: ' + e);
      });
    });
  }

  function onSignal(fromActorId, payload) {
    if (!payload || !payload.kind) { return; }
    var peer = state.peers[fromActorId];

    // Talking state can arrive for someone we have not connected to yet, and
    // it is not worth creating a connection over.
    if (payload.kind === 'talking') {
      setPeerTalking(fromActorId, !!payload.on);
      return;
    }

    if (payload.kind === 'offer') {
      // An offer can arrive before our own proximity tick has noticed them,
      // so accept it and create the peer on the spot.
      if (!peer) {
        ensureMic();
        peer = createPeer(fromActorId);
        if (!peer) { return; }
      }
      peer.pc.setRemoteDescription(payload.sdp).then(function () {
        peer.haveRemote = true;
        flushPendingIce(peer);
        attachLocalTracks(peer);
        return peer.pc.createAnswer();
      }).then(function (answer) {
        return peer.pc.setLocalDescription(answer).then(function () {
          signal(fromActorId, { kind: 'answer', sdp: peer.pc.localDescription });
        });
      }).catch(function (e) { report('error', 'answer failed: ' + e); });
      return;
    }

    if (!peer) { return; }

    if (payload.kind === 'answer') {
      peer.pc.setRemoteDescription(payload.sdp).then(function () {
        peer.haveRemote = true;
        flushPendingIce(peer);
      }).catch(function (e) { report('error', 'bad answer: ' + e); });
      return;
    }

    if (payload.kind === 'ice' && payload.candidate) {
      // Candidates routinely beat the description they belong to, and adding
      // one before setRemoteDescription throws.
      if (!peer.haveRemote) {
        peer.pendingIce.push(payload.candidate);
        return;
      }
      peer.pc.addIceCandidate(payload.candidate).catch(function (e) {
        report('warn', 'ice rejected: ' + e);
      });
    }
  }

  window.addEventListener('hearthheld:voiceSignal', function (ev) {
    try {
      onSignal(ev.detail.fromActorId, ev.detail.payload);
    } catch (e) {
      report('error', 'signal handling threw: ' + e);
    }
  });

  window.hhVoice = {
    /**
     * Called from the game process with everyone currently in range. The game
     * side owns proximity because only it knows where anybody is standing.
     */
    setPeers: function (selfActorId, list) {
      state.selfActorId = selfActorId;
      var seen = {};
      (list || []).forEach(function (entry) {
        var id = entry.actorId;
        if (!id || id === selfActorId) { return; }
        seen[id] = true;
        var peer = state.peers[id];
        if (!peer) {
          if (entry.distance > MAX_DISTANCE) { return; }
          ensureMic();
          peer = createPeer(id, entry.name);
          if (!peer) { return; }
        }
        if (entry.name) { peer.name = entry.name; }
        peer.distance = entry.distance;
        peer.audio.volume = volumeForDistance(entry.distance);
      });
      // Anyone who left the list entirely has gone out of range, changed cell,
      // or disconnected.
      Object.keys(state.peers).forEach(function (key) {
        var id = Number(key);
        var peer = state.peers[id];
        if (!seen[id] || peer.distance > DROP_DISTANCE) {
          removePeer(id);
        }
      });
      refreshUi();
    },

    setTransmitting: function (on) {
      on = !!on;
      // Typing a message is not a reason to open the microphone, and the key
      // press that produced this is the letter V in someone's sentence.
      if (on && isTyping()) {
        // Said out loud, because a key that does nothing looks identical to a
        // key that is not being read at all.
        var el = document.activeElement;
        report('info', 'key ignored, focus is in ' +
          ((el && el.tagName) || '?') + '.' + ((el && el.className) || '-'));
        return;
      }
      if (state.transmitting === on) { return; }
      state.transmitting = on;
      // The indicator updates whatever the microphone is doing, so that
      // pressing the key always produces visible feedback even when capture
      // is broken.
      refreshUi();
      if (!state.stream) {
        // First press of the key is a reasonable moment to ask, if proximity
        // has not already done so.
        if (on) { ensureMic(); }
        return;
      }
      state.stream.getAudioTracks().forEach(function (t) { t.enabled = on; });
      // Nearby players get told directly rather than guessing from audio
      // levels, which is both cheaper and accurate while you are silent.
      Object.keys(state.peers).forEach(function (id) {
        signal(Number(id), { kind: 'talking', on: on });
      });
    },

    status: function () {
      return {
        micReady: !!state.stream,
        micError: state.micError,
        transmitting: state.transmitting,
        peers: Object.keys(state.peers).length
      };
    }
  };

  refreshUi();
  report('info', 'voice runtime loaded');
})();
`;
