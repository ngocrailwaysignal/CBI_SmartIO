(() => {
  "use strict";
  const WEB_BUILD = "";
  const NODE_WIDTH = 96;
  const NODE_HEIGHT = 56;
  const TRAIN_BASE_WIDTH = 84;
  const TRAIN_BASE_HEIGHT = 44;
  const TRAIN_WIDTH = 56;
  const TRAIN_HEIGHT = 28;
  const CBI_VIEWBOX = Object.freeze({
    x: -700,
    y: -650,
    width: 1900,
    height: 700,
  });

  const refs = {
    wsUrl: document.getElementById("wsUrl"),
    connectBtn: document.getElementById("connectBtn"),
    connBadge: document.getElementById("connBadge"),
    connMeta: document.getElementById("connMeta"),
    runtimeHud: document.getElementById("runtimeHud"),
    diagram: document.getElementById("diagram"),
    routeSelect: document.getElementById("routeSelect"),
    activeRoute: document.getElementById("activeRoute"),
    addTrainBtn: document.getElementById("addTrainBtn"),
    clearTrainBtn: document.getElementById("clearTrainBtn"),
    autoStartBtn: document.getElementById("autoStartBtn"),
    autoStopBtn: document.getElementById("autoStopBtn"),
    runtimeDigest: document.getElementById("runtimeDigest"),
    toast: document.getElementById("toast"),
    buildTag: document.getElementById("buildTag"),
  };

  const state = {
    ws: null,
    connected: false,
    manualDisconnect: false,
    reconnectAttempts: 0,
    reconnectTimer: null,

    layout: null,
    layoutSectionIds: new Set(),
    sectionKinds: new Map(),
    pointMeta: new Map(),
    signalMeta: new Map(),
    anchors: new Map(),
    adjacency: new Map(),

    routePathMap: {
      by_active_route_id: {},
      by_compiled_id: {},
      by_pair: {},
    },
    selectedRouteId: "",
    connectedStats: {
      web_clients: 0,
      cbi_clients: 0,
    },

    tick: 0,
    sections: new Map(),
    points: new Map(),
    signals: new Map(),
    activeRoutes: new Map(),
    cbiTrains: new Map(),

    localTrains: new Map(),
    localTrainSerial: 1,
    autoTimer: null,
    drag: null,

    layers: {
      edges: null,
      sections: null,
      points: null,
      signals: null,
      labels: null,
      trains: null,
    },
    edgeNodes: [],
    sectionNodes: new Map(),
    pointNodes: new Map(),
    signalNodes: new Map(),
    trainNodes: new Map(),
  };

  function defaultWebSocketUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/smartio`;
  }

  function boot() {
    if (refs.buildTag) {
      refs.buildTag.textContent = `build: ${WEB_BUILD}`;
    }
    if (refs.wsUrl && !String(refs.wsUrl.value || "").trim()) {
      refs.wsUrl.value = defaultWebSocketUrl();
    }
    if (refs.connectBtn) {
      refs.connectBtn.addEventListener("click", onConnectClick);
    }
    if (refs.wsUrl) {
      refs.wsUrl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        connectSocket();
      });
    }
    if (refs.routeSelect) {
      refs.routeSelect.addEventListener("change", onRouteSelected);
    }
    if (refs.addTrainBtn) {
      refs.addTrainBtn.addEventListener("click", onAddTrain);
    }
    if (refs.clearTrainBtn) {
      refs.clearTrainBtn.addEventListener("click", onClearTrains);
    }
    if (refs.autoStartBtn) {
      refs.autoStartBtn.addEventListener("click", onAutoStart);
    }
    if (refs.autoStopBtn) {
      refs.autoStopBtn.addEventListener("click", onAutoStop);
    }
    if (refs.diagram) {
      refs.diagram.addEventListener("pointermove", onPointerMove);
      refs.diagram.addEventListener("pointerup", onPointerUp);
      refs.diagram.addEventListener("pointercancel", onPointerUp);
    }

    setConnectionBadge("offline", "offline", "-");
    connectSocket();
  }

  function onConnectClick() {
    if (state.connected) {
      disconnectSocket(true);
      return;
    }
    connectSocket();
  }

  function connectSocket() {
    const wsUrl = String(refs.wsUrl?.value || "").trim();
    if (!wsUrl) {
      showToast("WebSocket URL is empty.");
      return;
    }
    clearReconnectTimer();
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    state.manualDisconnect = false;
    setConnectionBadge("reconnecting", "connecting", "opening socket");

    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener("open", () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      setConnectionBadge("online", "online", "connected");
      if (refs.connectBtn) {
        refs.connectBtn.textContent = "Disconnect";
      }
      sendEnvelope("hello", { role: "web" });
    });

    ws.addEventListener("message", (event) => {
      onSocketMessage(event.data);
    });

    ws.addEventListener("close", () => {
      state.connected = false;
      if (refs.connectBtn) {
        refs.connectBtn.textContent = "Connect";
      }
      if (state.manualDisconnect) {
        setConnectionBadge("offline", "offline", "manual");
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (!state.connected) {
        setConnectionBadge("offline", "offline", "socket error");
      }
    });
  }

  function disconnectSocket(manual) {
    state.manualDisconnect = Boolean(manual);
    clearReconnectTimer();
    if (!state.ws) {
      state.connected = false;
      if (refs.connectBtn) {
        refs.connectBtn.textContent = "Connect";
      }
      setConnectionBadge("offline", "offline", "closed");
      return;
    }
    try {
      state.ws.close();
    } catch (_error) {
      // Ignore best-effort close errors.
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    state.reconnectAttempts += 1;
    const delayMs = Math.min(30000, Math.pow(2, state.reconnectAttempts - 1) * 1000);
    const delaySeconds = Math.max(1, Math.round(delayMs / 1000));
    setConnectionBadge("reconnecting", "reconnecting", `retry in ${delaySeconds}s`);
    state.reconnectTimer = window.setTimeout(() => {
      connectSocket();
    }, delayMs);
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer === null) {
      return;
    }
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  function setConnectionBadge(cssState, label, meta) {
    if (refs.connBadge) {
      refs.connBadge.classList.remove("online", "offline", "reconnecting");
      refs.connBadge.classList.add(cssState);
      refs.connBadge.textContent = label;
    }
    if (refs.connMeta) {
      refs.connMeta.textContent = String(meta || "-");
    }
    if (refs.connectBtn) {
      refs.connectBtn.textContent = state.connected ? "Disconnect" : "Connect";
    }
  }

  function sendEnvelope(type, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const envelope = {
      type: String(type || "").trim(),
      payload: payload && typeof payload === "object" ? payload : {},
      ts: Date.now() / 1000,
    };
    state.ws.send(JSON.stringify(envelope));
    return true;
  }

  function sendStateUpdate(payload) {
    const ok = sendEnvelope("state_update", payload);
    if (!ok) {
      showToast("Cannot send state_update while WebSocket is offline.");
    }
  }

  function localTrainsPayload() {
    return Array.from(state.localTrains.values())
      .map((train) => ({
        id: train.id,
        current_section: train.currentSection,
        route_id: train.routeId || null,
        speed: 1.0,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  function onSocketMessage(rawData) {
    let envelope;
    try {
      envelope = JSON.parse(rawData);
    } catch (_error) {
      return;
    }
    if (!envelope || typeof envelope !== "object") {
      return;
    }

    const type = String(envelope.type || "").trim();
    const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
    if (type === "sim_snapshot") {
      applySimSnapshot(payload);
      return;
    }
    if (type === "runtime_snapshot") {
      applyRuntimeSnapshot(payload);
      renderAll();
      return;
    }
    if (type === "cbi_command") {
      applyCbiCommand(payload);
      renderAll();
      return;
    }
    if (type === "error") {
      showToast(`Remote error: ${payload.message || payload.code || "UNKNOWN"}`);
    }
  }

  function applySimSnapshot(payload) {
    if (payload.layout && typeof payload.layout === "object") {
      loadLayout(payload.layout);
    }
    state.routePathMap = normalizeRoutePathMap(payload.route_path_map);
    if (payload.runtime && typeof payload.runtime === "object") {
      applyRuntimePayload(payload.runtime);
    }
    if (payload.runtime_snapshot && typeof payload.runtime_snapshot === "object") {
      applyRuntimeSnapshot(payload.runtime_snapshot);
    }
    if (payload.connected && typeof payload.connected === "object") {
      state.connectedStats = {
        web_clients: Number(payload.connected.web_clients || 0),
        cbi_clients: Number(payload.connected.cbi_clients || 0),
      };
    }
    renderAll();
  }

  function applyRuntimePayload(runtime) {
    if (Number.isFinite(Number(runtime.tick))) {
      state.tick = Math.max(0, Number(runtime.tick));
    }

    if (Array.isArray(runtime.sections)) {
      state.sections.clear();
      for (const section of runtime.sections) {
        if (!section || typeof section !== "object") {
          continue;
        }
        const sectionId = String(section.id || "").trim();
        if (!sectionId) {
          continue;
        }
        state.sections.set(sectionId, {
          occupied: Boolean(section.occupied),
          locked_by: stringOrNull(section.locked_by),
        });
      }
    }

    if (Array.isArray(runtime.points)) {
      state.points.clear();
      for (const point of runtime.points) {
        if (!point || typeof point !== "object") {
          continue;
        }
        const pointId = String(point.id || "").trim();
        if (!pointId) {
          continue;
        }
        state.points.set(pointId, {
          position: String(point.position || "").trim().toUpperCase(),
          locked_by: stringOrNull(point.locked_by),
        });
      }
    }

    if (Array.isArray(runtime.signals)) {
      state.signals.clear();
      for (const signal of runtime.signals) {
        if (!signal || typeof signal !== "object") {
          continue;
        }
        const signalId = String(signal.id || "").trim();
        if (!signalId) {
          continue;
        }
        state.signals.set(signalId, {
          aspect: String(signal.aspect || "STOP").trim().toUpperCase(),
          route_id: stringOrNull(signal.route_id),
        });
      }
    }

    if (Array.isArray(runtime.active_routes)) {
      setActiveRoutes(runtime.active_routes);
    }

    if (Array.isArray(runtime.trains)) {
      state.cbiTrains.clear();
      for (const train of runtime.trains) {
        if (!train || typeof train !== "object") {
          continue;
        }
        const trainId = String(train.id || "").trim();
        if (!trainId) {
          continue;
        }
        state.cbiTrains.set(trainId, {
          id: trainId,
          current_section: String(train.current_section || "").trim(),
          speed: Number(train.speed || 0),
          route_id: stringOrNull(train.route_id),
        });
      }
    }

    if (runtime.selected_route_id != null) {
      state.selectedRouteId = String(runtime.selected_route_id || "").trim();
    }
    ensureSelectedRoute();
  }

  function applyRuntimeSnapshot(snapshot) {
    if (Number.isFinite(Number(snapshot.tick))) {
      state.tick = Math.max(0, Number(snapshot.tick));
    }

    if (Array.isArray(snapshot.routes)) {
      setActiveRoutes(snapshot.routes);
    }

    if (Array.isArray(snapshot.occupancy)) {
      for (const nodeState of snapshot.occupancy) {
        if (!nodeState || typeof nodeState !== "object") {
          continue;
        }
        const nodeId = String(nodeState.id || "").trim();
        if (!nodeId) {
          continue;
        }
        if ("occupied" in nodeState) {
          state.sections.set(nodeId, {
            occupied: Boolean(nodeState.occupied),
            locked_by: stringOrNull(nodeState.locked_by),
          });
        }
        if ("position" in nodeState) {
          state.points.set(nodeId, {
            position: String(nodeState.position || "").trim().toUpperCase(),
            locked_by: stringOrNull(nodeState.locked_by),
          });
        }
      }
    }

    if (Array.isArray(snapshot.signal_state)) {
      for (const signalState of snapshot.signal_state) {
        if (!signalState || typeof signalState !== "object") {
          continue;
        }
        const signalId = String(signalState.id || "").trim();
        if (!signalId) {
          continue;
        }
        state.signals.set(signalId, {
          aspect: String(signalState.aspect || "STOP").trim().toUpperCase(),
          route_id: stringOrNull(signalState.route_id),
        });
      }
    }

    if (Array.isArray(snapshot.trains)) {
      state.cbiTrains.clear();
      for (const train of snapshot.trains) {
        if (!train || typeof train !== "object") {
          continue;
        }
        const trainId = String(train.id || "").trim();
        if (!trainId) {
          continue;
        }
        state.cbiTrains.set(trainId, {
          id: trainId,
          current_section: String(train.current_section || "").trim(),
          speed: Number(train.speed || 0),
          route_id: stringOrNull(train.route_id),
        });
      }
    }
    ensureSelectedRoute();
  }

  function applyCbiCommand(command) {
    const target = String(command.target || "").trim().toLowerCase();
    const targetId = String(command.id || "").trim();
    const action = String(command.action || "").trim().toLowerCase();
    const value = String(command.value || "").trim().toUpperCase();
    const context = command.context && typeof command.context === "object" ? command.context : {};

    if (target === "point" && action === "set_position" && targetId) {
      state.points.set(targetId, {
        position: value,
        locked_by: state.points.get(targetId)?.locked_by || null,
      });
      return;
    }

    if (!(target === "signal" && action === "set_aspect" && targetId)) {
      return;
    }

    state.signals.set(targetId, {
      aspect: value || "STOP",
      route_id: stringOrNull(context.route_id),
    });

    const routeId = String(context.route_id || "").trim();
    const entrySignal = String(context.entry_signal || "").trim() || targetId;
    const exitSignal = String(context.exit_signal || "").trim();

    if (value === "PROCEED") {
      const resolvedRouteId = routeId || routePairKey(entrySignal, exitSignal) || targetId;
      const activeRoute = normalizeRouteRecord({
        route_id: resolvedRouteId,
        entry_signal_id: entrySignal,
        exit_signal_id: exitSignal,
        path: context.path || context.route_path,
        overlap_path: context.overlap_path,
        lifecycle_state: context.lifecycle_state,
      });
      if (activeRoute) {
        state.activeRoutes.set(activeRoute.route_id, activeRoute);
      }
    } else if (value === "STOP") {
      if (routeId && state.activeRoutes.has(routeId)) {
        state.activeRoutes.delete(routeId);
      } else if (entrySignal && exitSignal) {
        for (const [activeRouteId, route] of state.activeRoutes.entries()) {
          if (route.entry_signal_id === entrySignal && route.exit_signal_id === exitSignal) {
            state.activeRoutes.delete(activeRouteId);
          }
        }
      } else {
        for (const [activeRouteId, route] of state.activeRoutes.entries()) {
          if (route.entry_signal_id === targetId) {
            state.activeRoutes.delete(activeRouteId);
          }
        }
      }
    }
    ensureSelectedRoute();
    syncRouteSelect();
  }

  function normalizeRoutePathMap(rawMap) {
    const fallback = {
      by_active_route_id: {},
      by_compiled_id: {},
      by_pair: {},
    };
    if (!rawMap || typeof rawMap !== "object") {
      return fallback;
    }
    if ("by_active_route_id" in rawMap || "by_compiled_id" in rawMap || "by_pair" in rawMap) {
      return {
        by_active_route_id: normalizePathDict(rawMap.by_active_route_id),
        by_compiled_id: normalizePathDict(rawMap.by_compiled_id),
        by_pair: normalizePathDict(rawMap.by_pair),
      };
    }
    return {
      by_active_route_id: {},
      by_compiled_id: normalizePathDict(rawMap),
      by_pair: {},
    };
  }

  function normalizePathDict(rawDict) {
    if (!rawDict || typeof rawDict !== "object") {
      return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(rawDict)) {
      const path = normalizeNodeList(value);
      if (!path.length) {
        continue;
      }
      normalized[String(key)] = path;
    }
    return normalized;
  }

  function setActiveRoutes(routeList) {
    state.activeRoutes.clear();
    for (const routeItem of routeList) {
      const route = normalizeRouteRecord(routeItem);
      if (!route) {
        continue;
      }
      state.activeRoutes.set(route.route_id, route);
    }
    ensureSelectedRoute();
    syncRouteSelect();
  }

  function normalizeRouteRecord(rawRoute) {
    if (!rawRoute || typeof rawRoute !== "object") {
      return null;
    }
    const routeId = String(rawRoute.route_id || rawRoute.id || "").trim();
    if (!routeId) {
      return null;
    }
    const entrySignal = String(rawRoute.entry_signal_id || rawRoute.entry_signal || "").trim();
    const exitSignal = String(rawRoute.exit_signal_id || rawRoute.exit_signal || "").trim();
    let path = normalizeNodeList(rawRoute.path);
    let overlapPath = normalizeNodeList(rawRoute.overlap_path || rawRoute.overlap);
    if (!path.length && !overlapPath.length) {
      const resolved = resolveRoutePath(routeId, entrySignal, exitSignal);
      path = resolved;
      overlapPath = [];
    }
    const fullPath = [...path, ...overlapPath];
    const mainSectionPath = path.filter((nodeId) => state.layoutSectionIds.has(nodeId));
    const sectionPath = fullPath.filter((nodeId) => state.layoutSectionIds.has(nodeId));
    return {
      route_id: routeId,
      entry_signal_id: entrySignal,
      exit_signal_id: exitSignal,
      path,
      overlap_path: overlapPath,
      full_path: fullPath,
      main_section_path: mainSectionPath,
      section_path: sectionPath,
      lifecycle_state: String(rawRoute.lifecycle_state || "").trim(),
    };
  }

  function resolveRoutePath(routeId, entrySignal, exitSignal) {
    const activeMap = state.routePathMap.by_active_route_id || {};
    if (routeId && Array.isArray(activeMap[routeId])) {
      return [...activeMap[routeId]];
    }
    const compiledMap = state.routePathMap.by_compiled_id || {};
    if (routeId && Array.isArray(compiledMap[routeId])) {
      return [...compiledMap[routeId]];
    }
    const pairKey = routePairKey(entrySignal, exitSignal);
    if (pairKey && Array.isArray((state.routePathMap.by_pair || {})[pairKey])) {
      return [...state.routePathMap.by_pair[pairKey]];
    }
    return [];
  }

  function routePairKey(entrySignal, exitSignal) {
    const entry = String(entrySignal || "").trim();
    const exit_ = String(exitSignal || "").trim();
    return entry && exit_ ? `${entry}->${exit_}` : "";
  }

  function normalizeNodeList(rawList) {
    if (!Array.isArray(rawList)) {
      return [];
    }
    const nodes = [];
    for (const item of rawList) {
      const token = String(item || "").trim();
      if (!token) {
        continue;
      }
      nodes.push(token);
    }
    return nodes;
  }

  function loadLayout(layout) {
    state.layout = layout;
    state.layoutSectionIds = new Set(
      Array.isArray(layout.sections)
        ? layout.sections.map((section) => String(section.id || "").trim()).filter(Boolean)
        : []
    );
    state.sectionKinds.clear();
    if (Array.isArray(layout.sections)) {
      for (const section of layout.sections) {
        if (!section || typeof section !== "object") {
          continue;
        }
        const sectionId = String(section.id || "").trim();
        if (!sectionId) {
          continue;
        }
        state.sectionKinds.set(sectionId, String(section.kind || "track").trim().toLowerCase());
      }
    }
    state.pointMeta.clear();
    if (Array.isArray(layout.points)) {
      for (const point of layout.points) {
        if (!point || typeof point !== "object") {
          continue;
        }
        const pointId = String(point.id || "").trim();
        if (!pointId) {
          continue;
        }
        state.pointMeta.set(pointId, {
          symbol_orientation: String(point.symbol_orientation || "RIGHT").trim().toUpperCase(),
        });
      }
    }
    state.signalMeta.clear();
    if (Array.isArray(layout.signals)) {
      for (const signal of layout.signals) {
        if (!signal || typeof signal !== "object") {
          continue;
        }
        const signalId = String(signal.id || "").trim();
        if (!signalId) {
          continue;
        }
        state.signalMeta.set(signalId, {
          direction: String(signal.direction || "RIGHT").trim().toUpperCase(),
        });
      }
    }
    buildAnchors(layout);
    buildAdjacency(layout);
    buildStaticDiagram(layout);
  }

  function buildAnchors(layout) {
    state.anchors.clear();
    const uiPositions = layout && typeof layout.ui_positions === "object" ? layout.ui_positions : {};
    for (const [nodeId, rawPoint] of Object.entries(uiPositions)) {
      if (!Array.isArray(rawPoint) || rawPoint.length < 2) {
        continue;
      }
      state.anchors.set(nodeId, { x: Number(rawPoint[0]), y: Number(rawPoint[1]) });
    }
  }

  function buildAdjacency(layout) {
    state.adjacency.clear();
    if (!layout) {
      return;
    }
    const allEdges = [];
    if (Array.isArray(layout.edges)) {
      allEdges.push(...layout.edges);
    }
    if (Array.isArray(layout.signal_links)) {
      allEdges.push(...layout.signal_links);
    }
    for (const rawEdge of allEdges) {
      if (!Array.isArray(rawEdge) || rawEdge.length < 2) {
        continue;
      }
      const source = String(rawEdge[0] || "").trim();
      const target = String(rawEdge[1] || "").trim();
      if (!source || !target) {
        continue;
      }
      pushAdjacency(source, target);
      pushAdjacency(target, source);
    }
  }

  function pushAdjacency(source, target) {
    if (!state.adjacency.has(source)) {
      state.adjacency.set(source, new Set());
    }
    state.adjacency.get(source).add(target);
  }

  function edgeAnchor(nodeId, towardX, towardY) {
    const anchor = state.anchors.get(nodeId);
    if (!anchor) {
      return { x: 0, y: 0 };
    }
    const left = anchor.x - NODE_WIDTH / 2;
    const right = anchor.x + NODE_WIDTH / 2;
    const top = anchor.y - NODE_HEIGHT / 2;
    const bottom = anchor.y + NODE_HEIGHT / 2;
    const dx = towardX - anchor.x;
    const dy = towardY - anchor.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx >= 0 ? right : left, y: anchor.y };
    }
    return { x: anchor.x, y: dy >= 0 ? bottom : top };
  }

  function createNodeGroup(nodeId) {
    const group = createSvg("g");
    group.dataset.nodeId = nodeId;
    group.classList.add("node");
    return group;
  }

  function buildSectionNode(sectionId, anchor) {
    const x0 = anchor.x - NODE_WIDTH / 2;
    const y0 = anchor.y - NODE_HEIGHT / 2;
    const group = createNodeGroup(sectionId);
    group.classList.add("section-node");
    const frame = createSvg("rect");
    frame.setAttribute("x", String(x0));
    frame.setAttribute("y", String(y0));
    frame.setAttribute("width", String(NODE_WIDTH));
    frame.setAttribute("height", String(NODE_HEIGHT));
    frame.setAttribute("class", "node-frame");
    group.appendChild(frame);

    const kind = state.sectionKinds.get(sectionId) || "track";
    if (kind === "approach") {
      const approachFrame = createSvg("rect");
      approachFrame.setAttribute("x", String(x0 + 2.5));
      approachFrame.setAttribute("y", String(y0 + 2.5));
      approachFrame.setAttribute("width", "91");
      approachFrame.setAttribute("height", "51");
      approachFrame.setAttribute("class", "approach-frame");
      group.appendChild(approachFrame);
    }

    const topLineY = y0 + NODE_HEIGHT * 0.2;
    const splitY = y0 + NODE_HEIGHT * 0.46;
    const leftX = x0 + 8;
    const rightX = x0 + NODE_WIDTH - 8;
    const tickHeight = NODE_HEIGHT * 0.14;
    const tickOffset = NODE_WIDTH * 0.12;

    const topLine = createSvg("line");
    topLine.setAttribute("x1", String(leftX));
    topLine.setAttribute("y1", String(topLineY));
    topLine.setAttribute("x2", String(rightX));
    topLine.setAttribute("y2", String(topLineY));
    topLine.setAttribute("class", "section-detail");
    group.appendChild(topLine);

    for (const x of [x0 + tickOffset, x0 + NODE_WIDTH - tickOffset]) {
      const tick = createSvg("line");
      tick.setAttribute("x1", String(x));
      tick.setAttribute("y1", String(topLineY));
      tick.setAttribute("x2", String(x));
      tick.setAttribute("y2", String(topLineY + tickHeight));
      tick.setAttribute("class", "section-detail");
      group.appendChild(tick);
    }

    const splitLine = createSvg("line");
    splitLine.setAttribute("x1", String(x0 + 2));
    splitLine.setAttribute("y1", String(splitY));
    splitLine.setAttribute("x2", String(x0 + NODE_WIDTH - 2));
    splitLine.setAttribute("y2", String(splitY));
    splitLine.setAttribute("class", "section-detail");
    group.appendChild(splitLine);

    const idText = createSvg("text");
    idText.setAttribute("x", String(anchor.x));
    idText.setAttribute("y", String(splitY + 10.5));
    idText.setAttribute("text-anchor", "middle");
    idText.setAttribute("dominant-baseline", "middle");
    idText.setAttribute("class", "node-id-text");
    idText.textContent = sectionId;
    group.appendChild(idText);

    const stateText = createSvg("text");
    stateText.setAttribute("x", String(anchor.x));
    stateText.setAttribute("y", String(splitY + 24.5));
    stateText.setAttribute("text-anchor", "middle");
    stateText.setAttribute("dominant-baseline", "middle");
    stateText.setAttribute("class", "section-state free");
    stateText.textContent = "FREE";
    group.appendChild(stateText);

    const marker = createSvg("circle");
    marker.setAttribute("cx", String(x0 + NODE_WIDTH - 7));
    marker.setAttribute("cy", String(y0 + 7));
    marker.setAttribute("r", "3");
    marker.setAttribute("class", "state-marker hidden");
    group.appendChild(marker);

    const highlight = createSvg("rect");
    highlight.setAttribute("x", String(x0 + 2));
    highlight.setAttribute("y", String(y0 + 2));
    highlight.setAttribute("width", String(NODE_WIDTH - 4));
    highlight.setAttribute("height", String(NODE_HEIGHT - 4));
    highlight.setAttribute("class", "node-highlight hidden");
    group.appendChild(highlight);
    return { group, stateText, marker, highlight };
  }

  function buildPointNode(pointId, anchor) {
    const group = createNodeGroup(pointId);
    group.classList.add("point-node");
    const panelSide = 48;
    const panelX = anchor.x - panelSide / 2;
    const panelY = anchor.y - panelSide / 2;
    const panel = createSvg("rect");
    panel.setAttribute("x", String(panelX));
    panel.setAttribute("y", String(panelY));
    panel.setAttribute("width", String(panelSide));
    panel.setAttribute("height", String(panelSide));
    panel.setAttribute("class", "point-panel");
    group.appendChild(panel);

    const orientation =
      (state.pointMeta.get(pointId) && state.pointMeta.get(pointId).symbol_orientation) || "RIGHT";
    const branchOffset = Math.max(6, panelSide * 0.3);
    const railHalf = panelSide / 2 - 2;
    let toeX = -railHalf;
    let toeY = 0;
    let straightX = railHalf;
    let straightY = 0;
    let branchX = railHalf;
    let branchY = -branchOffset;
    if (orientation === "LEFT") {
      toeX = railHalf;
      straightX = -railHalf;
      branchX = -railHalf;
      branchY = branchOffset;
    } else if (orientation === "UP") {
      toeX = railHalf;
      straightX = -railHalf;
      branchX = -railHalf;
      branchY = -branchOffset;
    } else if (orientation === "DOWN") {
      toeX = -railHalf;
      straightX = railHalf;
      branchX = railHalf;
      branchY = branchOffset;
    }

    const toe = { x: anchor.x + toeX, y: anchor.y + toeY };
    const straight = { x: anchor.x + straightX, y: anchor.y + straightY };
    const branch = { x: anchor.x + branchX, y: anchor.y + branchY };

    const straightLine = createSvg("line");
    straightLine.setAttribute("x1", String(toe.x));
    straightLine.setAttribute("y1", String(toe.y));
    straightLine.setAttribute("x2", String(straight.x));
    straightLine.setAttribute("y2", String(straight.y));
    straightLine.setAttribute("class", "point-rail");
    group.appendChild(straightLine);

    const branchLine = createSvg("line");
    branchLine.setAttribute("x1", String(toe.x));
    branchLine.setAttribute("y1", String(toe.y));
    branchLine.setAttribute("x2", String(branch.x));
    branchLine.setAttribute("y2", String(branch.y));
    branchLine.setAttribute("class", "point-rail");
    group.appendChild(branchLine);

    const label = createSvg("text");
    label.setAttribute("class", "node-id-text");
    label.setAttribute("text-anchor", "middle");
    const textLeft = branchX > 0 ? panelX + 1 : anchor.x + 1;
    const textTop = branchY < 0 ? anchor.y + 1 : panelY + 1;
    const textWidth = panelSide / 2 - 3;
    const textHeight = panelSide / 2 - 3;
    label.setAttribute("x", String(textLeft + textWidth / 2));
    label.setAttribute("y", String(textTop + textHeight / 2));
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = pointId;
    group.appendChild(label);

    const marker = createSvg("circle");
    marker.setAttribute("cx", String(anchor.x + NODE_WIDTH / 2 - 7));
    marker.setAttribute("cy", String(anchor.y - NODE_HEIGHT / 2 + 7));
    marker.setAttribute("r", "3");
    marker.setAttribute("class", "state-marker hidden");
    group.appendChild(marker);

    const highlight = createSvg("rect");
    highlight.setAttribute("x", String(anchor.x - 46));
    highlight.setAttribute("y", String(anchor.y - 26));
    highlight.setAttribute("width", "92");
    highlight.setAttribute("height", "52");
    highlight.setAttribute("class", "node-highlight hidden");
    group.appendChild(highlight);
    return { group, marker, highlight };
  }

  function buildSignalNode(signalId, anchor) {
    const x0 = anchor.x - NODE_WIDTH / 2;
    const y0 = anchor.y - NODE_HEIGHT / 2;
    const group = createNodeGroup(signalId);
    group.classList.add("signal-node");

    const outer = createSvg("rect");
    outer.setAttribute("x", String(x0 + 0.8));
    outer.setAttribute("y", String(y0 + 0.8));
    outer.setAttribute("width", "94.4");
    outer.setAttribute("height", "54.4");
    outer.setAttribute("class", "node-frame");
    group.appendChild(outer);

    const splitY = y0 + NODE_HEIGHT - Math.max(24, NODE_HEIGHT * 0.28);
    const splitLine = createSvg("line");
    splitLine.setAttribute("x1", String(x0 + 2.3));
    splitLine.setAttribute("y1", String(splitY));
    splitLine.setAttribute("x2", String(x0 + 93.7));
    splitLine.setAttribute("y2", String(splitY));
    splitLine.setAttribute("class", "signal-detail");
    group.appendChild(splitLine);

    const topX = x0 + 5;
    const topY = y0 + 4;
    const topW = 86;
    const topH = splitY - y0 - 8;
    const mastX = anchor.x;
    const mastTop = topY + 6;
    const mastBottom = topY + topH - 4;
    const mast = createSvg("line");
    mast.setAttribute("x1", String(mastX));
    mast.setAttribute("y1", String(mastTop));
    mast.setAttribute("x2", String(mastX));
    mast.setAttribute("y2", String(mastBottom));
    mast.setAttribute("class", "signal-detail");
    group.appendChild(mast);

    const direction = (state.signalMeta.get(signalId) && state.signalMeta.get(signalId).direction) || "RIGHT";
    const armY = topY + topH * 0.35;
    const armLength = Math.max(16, topW * 0.32);
    const faceLeft = direction === "LEFT";
    const headX = faceLeft ? mastX - armLength : mastX + armLength;
    const stopBarX = faceLeft ? headX - 8 : headX + 8;

    const arm = createSvg("line");
    arm.setAttribute("x1", String(mastX));
    arm.setAttribute("y1", String(armY));
    arm.setAttribute("x2", String(headX));
    arm.setAttribute("y2", String(armY));
    arm.setAttribute("class", "signal-detail");
    group.appendChild(arm);

    const lamp = createSvg("circle");
    lamp.setAttribute("cx", String(headX));
    lamp.setAttribute("cy", String(armY));
    lamp.setAttribute("r", "6");
    lamp.setAttribute("class", "signal-lamp stop");
    group.appendChild(lamp);

    const stopBar = createSvg("line");
    stopBar.setAttribute("x1", String(stopBarX));
    stopBar.setAttribute("y1", String(armY - 6));
    stopBar.setAttribute("x2", String(stopBarX));
    stopBar.setAttribute("y2", String(armY + 6));
    stopBar.setAttribute("class", "signal-detail");
    group.appendChild(stopBar);

    const label = createSvg("text");
    label.setAttribute("x", String(anchor.x));
    label.setAttribute("y", String(splitY + 11.5));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.setAttribute("class", "node-id-text");
    label.textContent = signalId;
    group.appendChild(label);

    const highlight = createSvg("rect");
    highlight.setAttribute("x", String(x0 + 2));
    highlight.setAttribute("y", String(y0 + 2));
    highlight.setAttribute("width", String(NODE_WIDTH - 4));
    highlight.setAttribute("height", String(NODE_HEIGHT - 4));
    highlight.setAttribute("class", "node-highlight hidden");
    group.appendChild(highlight);
    return { group, lamp, highlight };
  }

  function buildStaticDiagram(layout) {
    refs.diagram.innerHTML = "";
    state.edgeNodes = [];
    state.sectionNodes.clear();
    state.pointNodes.clear();
    state.signalNodes.clear();
    state.trainNodes.clear();

    state.layers.edges = createSvg("g");
    state.layers.sections = createSvg("g");
    state.layers.points = createSvg("g");
    state.layers.signals = createSvg("g");
    state.layers.trains = createSvg("g");

    refs.diagram.appendChild(state.layers.edges);
    refs.diagram.appendChild(state.layers.sections);
    refs.diagram.appendChild(state.layers.points);
    refs.diagram.appendChild(state.layers.signals);
    refs.diagram.appendChild(state.layers.trains);

    const edgePairs = [];
    if (Array.isArray(layout.edges)) {
      for (const rawEdge of layout.edges) {
        if (!Array.isArray(rawEdge) || rawEdge.length < 2) {
          continue;
        }
        edgePairs.push([String(rawEdge[0] || "").trim(), String(rawEdge[1] || "").trim()]);
      }
    }
    if (Array.isArray(layout.signal_links)) {
      for (const rawEdge of layout.signal_links) {
        if (!Array.isArray(rawEdge) || rawEdge.length < 2) {
          continue;
        }
        edgePairs.push([String(rawEdge[0] || "").trim(), String(rawEdge[1] || "").trim()]);
      }
    }
    const seenEdges = new Set();
    for (const pair of edgePairs) {
      const sourceId = pair[0];
      const targetId = pair[1];
      if (!sourceId || !targetId) {
        continue;
      }
      const edgeKey = `${sourceId}=>${targetId}`;
      if (seenEdges.has(edgeKey)) {
        continue;
      }
      seenEdges.add(edgeKey);
      const source = state.anchors.get(sourceId);
      const target = state.anchors.get(targetId);
      if (!source || !target) {
        continue;
      }
      const start = edgeAnchor(sourceId, target.x, target.y);
      const endBase = edgeAnchor(targetId, source.x, source.y);
      let end = { ...endBase };
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 18) {
        const inset = Math.min(10, distance * 0.35);
        end = {
          x: end.x - (dx / distance) * inset,
          y: end.y - (dy / distance) * inset,
        };
      }
      const line = createSvg("line");
      line.setAttribute("x1", String(start.x));
      line.setAttribute("y1", String(start.y));
      line.setAttribute("x2", String(end.x));
      line.setAttribute("y2", String(end.y));
      line.setAttribute("class", "track-line");
      state.layers.edges.appendChild(line);
      state.edgeNodes.push({
        source: sourceId,
        target: targetId,
        element: line,
      });
    }

    if (Array.isArray(layout.sections)) {
      for (const section of layout.sections) {
        const sectionId = String(section.id || "").trim();
        const anchor = state.anchors.get(sectionId);
        if (!sectionId || !anchor) {
          continue;
        }
        const node = buildSectionNode(sectionId, anchor);
        state.layers.sections.appendChild(node.group);
        state.sectionNodes.set(sectionId, node);
      }
    }

    if (Array.isArray(layout.points)) {
      for (const point of layout.points) {
        const pointId = String(point.id || "").trim();
        const anchor = state.anchors.get(pointId);
        if (!pointId || !anchor) {
          continue;
        }
        const node = buildPointNode(pointId, anchor);
        state.layers.points.appendChild(node.group);
        state.pointNodes.set(pointId, node);
      }
    }

    if (Array.isArray(layout.signals)) {
      for (const signal of layout.signals) {
        const signalId = String(signal.id || "").trim();
        const anchor = state.anchors.get(signalId);
        if (!signalId || !anchor) {
          continue;
        }
        const node = buildSignalNode(signalId, anchor);
        state.layers.signals.appendChild(node.group);
        state.signalNodes.set(signalId, node);
      }
    }

    applyViewBox();
  }

  function applyViewBox() {
    if (!refs.diagram) {
      return;
    }
    refs.diagram.setAttribute(
      "viewBox",
      `${CBI_VIEWBOX.x} ${CBI_VIEWBOX.y} ${CBI_VIEWBOX.width} ${CBI_VIEWBOX.height}`
    );
  }

  function onRouteSelected() {
    if (!refs.routeSelect) {
      return;
    }
    state.selectedRouteId = String(refs.routeSelect.value || "").trim();
    sendEnvelope("web_control", {
      action: "set_selected_route",
      route_id: state.selectedRouteId,
    });
    renderAll();
  }

  function ensureSelectedRoute() {
    if (state.selectedRouteId && state.activeRoutes.has(state.selectedRouteId)) {
      return;
    }
    const sortedRouteIds = Array.from(state.activeRoutes.keys()).sort();
    state.selectedRouteId = sortedRouteIds[0] || "";
  }

  function syncRouteSelect() {
    if (!refs.routeSelect) {
      ensureSelectedRoute();
      return;
    }
    const previous = String(refs.routeSelect.value || "").trim();
    refs.routeSelect.innerHTML = "";
    const routeIds = Array.from(state.activeRoutes.keys()).sort();
    if (!routeIds.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No active routes";
      refs.routeSelect.appendChild(empty);
      refs.routeSelect.disabled = true;
      state.selectedRouteId = "";
      return;
    }
    refs.routeSelect.disabled = false;
    for (const routeId of routeIds) {
      const route = state.activeRoutes.get(routeId);
      const option = document.createElement("option");
      option.value = routeId;
      option.textContent = `${routeId} (${route.entry_signal_id || "-"} -> ${route.exit_signal_id || "-"})`;
      refs.routeSelect.appendChild(option);
    }
    const preferred = state.selectedRouteId || previous;
    const selectedRouteId = routeIds.includes(preferred) ? preferred : routeIds[0];
    refs.routeSelect.value = selectedRouteId;
    state.selectedRouteId = selectedRouteId;
  }

  function onAddTrain() {
    const routeId = state.selectedRouteId || String(refs.routeSelect?.value || "").trim();
    if (!routeId || !state.activeRoutes.has(routeId)) {
      showToast("Select one active route before adding a train.");
      return;
    }
    const route = state.activeRoutes.get(routeId);
    const mainPath = Array.isArray(route.main_section_path) ? route.main_section_path : [];
    const autoPath = mainPath.length ? mainPath : route.section_path;
    if (!autoPath.length) {
      showToast(`Route ${routeId} has no section path for movement.`);
      return;
    }
    const startSection = autoPath[0];
    if (!canOccupySection(startSection, null)) {
      showToast(`Cannot spawn train. Section ${startSection} is occupied.`);
      return;
    }

    const trainId = `W${state.localTrainSerial++}`;
    state.localTrains.set(trainId, {
      id: trainId,
      routeId: routeId,
      // Auto-run should stop at route body and not enter overlap.
      sectionPath: [...autoPath],
      index: 0,
      currentSection: startSection,
    });
    updateSectionOccupancyForMove(null, startSection, trainId);
    renderAll();
  }

  function onClearTrains() {
    if (!state.localTrains.size) {
      return;
    }
    const sectionsToFree = new Set();
    for (const train of state.localTrains.values()) {
      if (train.currentSection) {
        sectionsToFree.add(train.currentSection);
      }
    }
    state.localTrains.clear();
    state.trainNodes.clear();

    const updates = [];
    for (const sectionId of sectionsToFree) {
      const sectionState = state.sections.get(sectionId) || { occupied: false, locked_by: null };
      sectionState.occupied = false;
      state.sections.set(sectionId, sectionState);
      updates.push({ id: sectionId, occupied: false });
    }
    if (updates.length) {
      sendStateUpdate({ sections: updates, trains: localTrainsPayload() });
    }
    renderAll();
  }

  function onAutoStart() {
    if (state.autoTimer !== null) {
      return;
    }
    state.autoTimer = window.setInterval(() => {
      runAutoStep();
    }, 900);
  }

  function onAutoStop() {
    if (state.autoTimer === null) {
      return;
    }
    window.clearInterval(state.autoTimer);
    state.autoTimer = null;
  }

  function runAutoStep() {
    const trainIds = Array.from(state.localTrains.keys()).sort();
    for (const trainId of trainIds) {
      const train = state.localTrains.get(trainId);
      if (!train) {
        continue;
      }
      const nextSection = train.sectionPath[train.index + 1] || "";
      if (!nextSection) {
        continue;
      }
      if (!canOccupySection(nextSection, trainId)) {
        continue;
      }
      commitTrainMove(trainId, nextSection, true);
    }
  }

  function commitTrainMove(trainId, targetSection, silent) {
    const train = state.localTrains.get(trainId);
    if (!train) {
      return false;
    }
    const expectedNext = train.sectionPath[train.index + 1] || "";
    if (targetSection !== expectedNext) {
      if (!silent) {
        showToast(`Invalid move for ${trainId}. Expected ${expectedNext || "END"} .`);
      }
      return false;
    }
    if (!canOccupySection(targetSection, trainId)) {
      if (!silent) {
        showToast(`Section ${targetSection} is occupied.`);
      }
      return false;
    }
    const oldSection = train.currentSection;
    train.index += 1;
    train.currentSection = targetSection;
    updateSectionOccupancyForMove(oldSection, targetSection, trainId);
    renderAll();
    return true;
  }

  function canOccupySection(sectionId, movingTrainId) {
    const token = String(sectionId || "").trim();
    if (!token) {
      return false;
    }
    if (!state.layoutSectionIds.has(token)) {
      return false;
    }
    const localOccupants = localTrainCount(token, movingTrainId);
    if (localOccupants > 0) {
      return false;
    }
    const sectionState = state.sections.get(token);
    if (!sectionState || !sectionState.occupied) {
      return true;
    }
    if (!movingTrainId) {
      return false;
    }
    const movingTrain = state.localTrains.get(movingTrainId);
    return Boolean(movingTrain && movingTrain.currentSection === token);
  }

  function localTrainCount(sectionId, excludingTrainId) {
    let count = 0;
    for (const [trainId, train] of state.localTrains.entries()) {
      if (excludingTrainId && trainId === excludingTrainId) {
        continue;
      }
      if (train.currentSection === sectionId) {
        count += 1;
      }
    }
    return count;
  }

  function updateSectionOccupancyForMove(oldSection, newSection, movingTrainId) {
    const updates = [];
    const oldToken = String(oldSection || "").trim();
    const newToken = String(newSection || "").trim();

    if (newToken) {
      const sectionState = state.sections.get(newToken) || { occupied: false, locked_by: null };
      sectionState.occupied = true;
      state.sections.set(newToken, sectionState);
      updates.push({ id: newToken, occupied: true });
    }

    if (oldToken && oldToken !== newToken) {
      const remaining = localTrainCount(oldToken, movingTrainId);
      if (remaining === 0) {
        const sectionState = state.sections.get(oldToken) || { occupied: false, locked_by: null };
        sectionState.occupied = false;
        state.sections.set(oldToken, sectionState);
        updates.push({ id: oldToken, occupied: false });
      }
    }

    if (updates.length) {
      sendStateUpdate({ sections: updates, trains: localTrainsPayload() });
    }
  }

  function onPointerMove(event) {
    if (!state.drag) {
      return;
    }
    const trainNode = state.trainNodes.get(state.drag.trainId);
    if (!trainNode) {
      return;
    }
    const scenePoint = clientToSvgPoint(event.clientX, event.clientY);
    trainNode.setAttribute("transform", `translate(${scenePoint.x}, ${scenePoint.y})`);
    trainNode.classList.add("dragging");

    clearDropTargets();
    const nearest = findNearestSection(scenePoint.x, scenePoint.y, 36);
    if (nearest) {
      const sectionNode = state.sectionNodes.get(nearest.sectionId);
      if (sectionNode) {
        sectionNode.group.classList.add("drop-target");
      }
    }
  }

  function onPointerUp(event) {
    if (!state.drag) {
      return;
    }
    const drag = state.drag;
    state.drag = null;
    clearDropTargets();

    const scenePoint = clientToSvgPoint(event.clientX, event.clientY);
    const nearest = findNearestSection(scenePoint.x, scenePoint.y, 36);
    if (!nearest) {
      renderAll();
      return;
    }
    commitTrainMove(drag.trainId, nearest.sectionId, false);
    renderAll();
  }

  function findNearestSection(x, y, maxDistance) {
    let best = null;
    let bestDistance = Number(maxDistance || 0);
    for (const [sectionId, anchor] of state.anchors.entries()) {
      if (!state.layoutSectionIds.has(sectionId)) {
        continue;
      }
      const distance = Math.hypot(anchor.x - x, anchor.y - y);
      if (distance > bestDistance) {
        continue;
      }
      bestDistance = distance;
      best = { sectionId, distance };
    }
    return best;
  }

  function clearDropTargets() {
    for (const node of state.sectionNodes.values()) {
      node.group.classList.remove("drop-target");
    }
  }

  function renderAll() {
    syncRouteSelect();
    renderDynamicLayers();
    renderRuntimeDigest();
  }

  function renderDynamicLayers() {
    const selectedRoute = state.activeRoutes.get(state.selectedRouteId) || null;
    const routePath =
      selectedRoute && Array.isArray(selectedRoute.path) && selectedRoute.path.length
        ? selectedRoute.path
        : selectedRoute
          ? selectedRoute.full_path
          : [];
    const routeNodes = new Set(routePath);
    const overlapNodes = new Set(selectedRoute ? selectedRoute.overlap_path : []);
    const highlightedPairs = new Set();
    if (selectedRoute && Array.isArray(selectedRoute.full_path)) {
      for (let index = 0; index < selectedRoute.full_path.length - 1; index += 1) {
        const source = selectedRoute.full_path[index];
        const target = selectedRoute.full_path[index + 1];
        highlightedPairs.add(`${source}=>${target}`);
        highlightedPairs.add(`${target}=>${source}`);
      }
    }

    for (const [sectionId, sectionNode] of state.sectionNodes.entries()) {
      const sectionState = state.sections.get(sectionId) || { occupied: false, locked_by: null };
      const occupied = Boolean(sectionState.occupied);
      const locked = Boolean(sectionState.locked_by);
      sectionNode.group.classList.toggle("occupied", occupied);
      sectionNode.group.classList.toggle("locked", locked);
      const isRoute = routeNodes.has(sectionId);
      const isOverlap = overlapNodes.has(sectionId);
      sectionNode.highlight.classList.toggle("hidden", !(isRoute || isOverlap));
      sectionNode.highlight.classList.toggle("route", isRoute);
      sectionNode.highlight.classList.toggle("overlap", overlapNodes.has(sectionId));
      sectionNode.stateText.textContent = occupied ? "OCCUPIED" : "FREE";
      sectionNode.stateText.classList.toggle("occupied", occupied);
      sectionNode.stateText.classList.toggle("free", !occupied);
      sectionNode.marker.classList.toggle("hidden", !(occupied || locked));
      sectionNode.marker.classList.toggle("occupied", occupied);
      sectionNode.marker.classList.toggle("locked", !occupied && locked);
    }

    for (const [pointId, pointNode] of state.pointNodes.entries()) {
      const pointState = state.points.get(pointId) || { position: "NORMAL", locked_by: null };
      const locked = Boolean(pointState.locked_by);
      pointNode.group.classList.toggle("locked", locked);
      const isRoute = routeNodes.has(pointId);
      const isOverlap = overlapNodes.has(pointId);
      pointNode.highlight.classList.toggle("hidden", !(isRoute || isOverlap));
      pointNode.highlight.classList.toggle("route", isRoute);
      pointNode.highlight.classList.toggle("overlap", overlapNodes.has(pointId));
      pointNode.marker.classList.toggle("hidden", !locked);
      pointNode.marker.classList.toggle("locked", locked);
    }

    for (const [signalId, signalNode] of state.signalNodes.entries()) {
      const signalState = state.signals.get(signalId) || { aspect: "STOP", route_id: null };
      const aspect = String(signalState.aspect || "STOP").toUpperCase();
      signalNode.lamp.classList.toggle("proceed", aspect === "PROCEED");
      signalNode.lamp.classList.toggle("stop", aspect !== "PROCEED");
      const isRoute = routeNodes.has(signalId);
      const isOverlap = overlapNodes.has(signalId);
      signalNode.highlight.classList.toggle("hidden", !(isRoute || isOverlap));
      signalNode.highlight.classList.toggle("route", isRoute);
      signalNode.highlight.classList.toggle("overlap", overlapNodes.has(signalId));
    }

    for (const edge of state.edgeNodes) {
      const active = highlightedPairs.has(`${edge.source}=>${edge.target}`);
      edge.element.classList.toggle("route", active);
    }

    renderLocalTrains();

    if (refs.activeRoute) {
      const routeLabel = selectedRoute
        ? `${selectedRoute.route_id} (${selectedRoute.entry_signal_id || "-"} -> ${selectedRoute.exit_signal_id || "-"})`
        : "-";
      refs.activeRoute.textContent = `Selected Route: ${routeLabel}`;
    }
  }

  function renderLocalTrains() {
    if (!state.layers.trains) {
      return;
    }
    state.layers.trains.innerHTML = "";
    state.trainNodes.clear();

    for (const [trainId, train] of state.localTrains.entries()) {
      const anchor = state.anchors.get(train.currentSection);
      if (!anchor) {
        continue;
      }
      const group = createSvg("g");
      const baseX = anchor.x - TRAIN_WIDTH / 2;
      const baseY = anchor.y - TRAIN_HEIGHT / 2 - 3;
      const previousSection =
        train.index > 0 ? String(train.sectionPath[train.index - 1] || "").trim() : "";
      const previousAnchor = previousSection ? state.anchors.get(previousSection) : null;
      const facingLeft = Boolean(previousAnchor && anchor.x < previousAnchor.x);
      if (facingLeft) {
        group.setAttribute(
          "transform",
          `translate(${baseX + TRAIN_WIDTH}, ${baseY}) scale(-1, 1)`
        );
      } else {
        group.setAttribute("transform", `translate(${baseX}, ${baseY})`);
      }
      group.dataset.trainId = trainId;
      group.classList.add("train");

      const drawing = createSvg("g");
      drawing.setAttribute(
        "transform",
        `scale(${TRAIN_WIDTH / TRAIN_BASE_WIDTH}, ${TRAIN_HEIGHT / TRAIN_BASE_HEIGHT})`
      );

      const shell = createSvg("path");
      shell.setAttribute(
        "d",
        "M8 7 L56 7 Q65 7 70 14 L78 25 Q82 30 80 35 Q78 39 72 39 L8 39 Q4 39 4 35 L4 12 Q4 7 8 7 Z"
      );
      shell.setAttribute("class", "train-shell");

      const stripe = createSvg("rect");
      stripe.setAttribute("x", "4.6");
      stripe.setAttribute("y", "26");
      stripe.setAttribute("width", "74");
      stripe.setAttribute("height", "11");
      stripe.setAttribute("rx", "5");
      stripe.setAttribute("class", "train-stripe");

      const win1 = createSvg("rect");
      win1.setAttribute("x", "12");
      win1.setAttribute("y", "11");
      win1.setAttribute("width", "14");
      win1.setAttribute("height", "18");
      win1.setAttribute("rx", "2.5");
      win1.setAttribute("class", "train-window");

      const win2 = createSvg("rect");
      win2.setAttribute("x", "31.5");
      win2.setAttribute("y", "12.5");
      win2.setAttribute("width", "13.5");
      win2.setAttribute("height", "10.5");
      win2.setAttribute("rx", "2");
      win2.setAttribute("class", "train-window");

      const frontWindow = createSvg("polygon");
      frontWindow.setAttribute("points", "49,12 61,12 67.5,22 49,22");
      frontWindow.setAttribute("class", "train-window");

      const wheel1 = createSvg("circle");
      wheel1.setAttribute("cx", "42.3");
      wheel1.setAttribute("cy", "38.3");
      wheel1.setAttribute("r", "4.3");
      wheel1.setAttribute("class", "train-wheel");

      const wheel2 = createSvg("circle");
      wheel2.setAttribute("cx", "57.3");
      wheel2.setAttribute("cy", "38.3");
      wheel2.setAttribute("r", "4.3");
      wheel2.setAttribute("class", "train-wheel");

      const trim1 = createSvg("line");
      trim1.setAttribute("x1", "12");
      trim1.setAttribute("y1", "17.5");
      trim1.setAttribute("x2", "20");
      trim1.setAttribute("y2", "17.5");
      trim1.setAttribute("class", "train-trim");

      const trim2 = createSvg("line");
      trim2.setAttribute("x1", "12");
      trim2.setAttribute("y1", "22");
      trim2.setAttribute("x2", "20");
      trim2.setAttribute("y2", "22");
      trim2.setAttribute("class", "train-trim");

      const baseLine1 = createSvg("line");
      baseLine1.setAttribute("x1", "6");
      baseLine1.setAttribute("y1", "24.4");
      baseLine1.setAttribute("x2", "55");
      baseLine1.setAttribute("y2", "24.4");
      baseLine1.setAttribute("class", "train-base");

      const baseLine2 = createSvg("line");
      baseLine2.setAttribute("x1", "60");
      baseLine2.setAttribute("y1", "24.4");
      baseLine2.setAttribute("x2", "78");
      baseLine2.setAttribute("y2", "24.4");
      baseLine2.setAttribute("class", "train-base");

      drawing.appendChild(shell);
      drawing.appendChild(stripe);
      drawing.appendChild(win1);
      drawing.appendChild(win2);
      drawing.appendChild(frontWindow);
      drawing.appendChild(wheel1);
      drawing.appendChild(wheel2);
      drawing.appendChild(trim1);
      drawing.appendChild(trim2);
      drawing.appendChild(baseLine1);
      drawing.appendChild(baseLine2);
      group.appendChild(drawing);
      group.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        state.drag = { trainId };
        group.classList.add("dragging");
      });
      state.layers.trains.appendChild(group);
      state.trainNodes.set(trainId, group);
    }
  }

  function renderRuntimeDigest() {
    const activeRoutes = Array.from(state.activeRoutes.values()).sort((left, right) =>
      left.route_id.localeCompare(right.route_id)
    );
    const localTrains = Array.from(state.localTrains.values()).sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const cbiTrains = Array.from(state.cbiTrains.values()).sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const occupiedCount = Array.from(state.sections.values()).filter((sectionState) =>
      Boolean(sectionState.occupied)
    ).length;
    const autoMode = state.autoTimer !== null ? "ON" : "OFF";
    if (refs.runtimeHud) {
      refs.runtimeHud.textContent =
        `CBI Clients: ${state.connectedStats.cbi_clients} | Web Clients: ${state.connectedStats.web_clients} | ` +
        `Routes: ${activeRoutes.length} | Local Trains: ${localTrains.length} | ` +
        `CBI Trains: ${cbiTrains.length} | OCC: ${occupiedCount} | Auto: ${autoMode}`;
    }
  }

  function createSvg(tagName) {
    return document.createElementNS("http://www.w3.org/2000/svg", tagName);
  }

  function clientToSvgPoint(clientX, clientY) {
    const point = refs.diagram.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = refs.diagram.getScreenCTM();
    if (!matrix) {
      return { x: 0, y: 0 };
    }
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  function stringOrNull(value) {
    if (value == null) {
      return null;
    }
    const token = String(value).trim();
    return token || null;
  }

  function showToast(message) {
    const text = String(message || "").trim();
    if (!text) {
      return;
    }
    refs.toast.textContent = text;
    refs.toast.classList.remove("hidden");
    window.setTimeout(() => {
      refs.toast.classList.add("hidden");
    }, 2400);
  }

  boot();
})();
