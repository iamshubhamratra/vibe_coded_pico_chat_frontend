import "./style.css";
import gsap from "gsap";
import { io, type Socket } from "socket.io-client";

type View = "landing" | "auth" | "dashboard" | "room";
type AuthMode = "login" | "signup";
type RoomType = "text" | "video";
type RoomMode = "duo" | "group";

type User = {
  userId: string;
  name: string;
  email: string;
};

type PendingUser = {
  userId: string;
  name: string;
};

type RoomMember = {
  userId: string;
  name: string;
  micOn: boolean;
  camOn: boolean;
};

type RoomState = {
  roomId: string;
  label: string;
  roomType: RoomType;
  mode: RoomMode;
  adminId: string;
  members: RoomMember[];
  pending: PendingUser[];
  maxUsers: number;
};

type ChatMessage = {
  roomId: string;
  userId: string;
  name: string;
  text: string;
  ts: number;
};

type JoinRequest = {
  roomId: string;
  userId: string;
  name: string;
};

type SignalPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

function isSessionDescription(signal: SignalPayload): signal is RTCSessionDescriptionInit {
  return "type" in signal && typeof signal.type === "string";
}

type AppState = {
  view: View;
  authMode: AuthMode;
  token: string | null;
  user: User | null;
  selectedRoomType: RoomType;
  selectedRoomMode: RoomMode;
  activeRoom: RoomState | null;
  roomMessages: ChatMessage[];
  roomNotice: string;
  roomNoticeType: "info" | "success" | "error";
  joinRequests: JoinRequest[];
  joinRoomCode: string;
  chatHasMore: boolean;
  chatLoading: boolean;
  localMicOn: boolean;
  localCamOn: boolean;
};

const appRoot = document.querySelector("#app");
if (!appRoot) {
  throw new Error("Missing #app root element.");
}

const EMOJIS = [
  "\u{1F600}",
  "\u{1F602}",
  "\u{1F60D}",
  "\u{1F525}",
  "\u{1F389}",
  "\u{1F497}",
  "\u{1F680}",
  "\u{1F436}"
];

const state: AppState = {
  view: "landing",
  authMode: "login",
  token: null,
  user: null,
  selectedRoomType: "text",
  selectedRoomMode: "duo",
  activeRoom: null,
  roomMessages: [],
  roomNotice: "",
  roomNoticeType: "info",
  joinRequests: [],
  joinRoomCode: "",
  chatHasMore: false,
  chatLoading: false,
  localMicOn: true,
  localCamOn: true
};

const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "::1";

const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? (isLocalHost ? "http://localhost:3000" : window.location.origin);
const socketUrl =
  (import.meta.env.VITE_SOCKET_URL as string | undefined) ??
  (isLocalHost ? "http://localhost:3000" : window.location.origin);
let socket: Socket | null = null;

let localStream: MediaStream | null = null;
const peers = new Map<string, RTCPeerConnection>();
const remoteStreams = new Map<string, MediaStream>();
const pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
let peerSyncTimer: number | null = null;
type VoiceAnalyserEntry = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
};
let voiceAudioContext: AudioContext | null = null;
const voiceAnalysers = new Map<string, VoiceAnalyserEntry>();
const voiceLevels = new Map<string, number>();
let micMeterFrame: number | null = null;

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers, credentials: "include" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text.slice(0, 120)}`);
  }
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed");
  }
  return data;
}

function setNotice(text: string, type: "info" | "success" | "error" = "info"): void {
  state.roomNotice = text;
  state.roomNoticeType = type;
  if (state.view === "room") {
    const noticeEl = document.querySelector(".notice") as HTMLElement | null;
    if (noticeEl) {
      noticeEl.textContent = text;
      noticeEl.className = `notice notice-${type}`;
    }
    return;
  }
  render();
}

function messageHtml(message: ChatMessage): string {
  return `
      <div class="msg ${message.userId === state.user?.userId ? "self" : ""}">
        <p>${esc(message.name)}</p>
        <span>${esc(message.text)}</span>
      </div>
    `;
}

function appendMessageToRoomDom(message: ChatMessage): boolean {
  if (state.view !== "room") {
    return false;
  }
  const messagesEl = document.querySelector(".messages") as HTMLElement | null;
  if (!messagesEl) {
    return false;
  }
  const emptyHint = messagesEl.querySelector(".sub");
  if (emptyHint) {
    emptyHint.remove();
  }
  messagesEl.insertAdjacentHTML("beforeend", messageHtml(message));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return true;
}

function updateUserMediaDom(userId: string, micOn: boolean, camOn: boolean): void {
  const tile = document.querySelector(`.video-box[data-user-id="${userId}"]`) as HTMLElement | null;
  if (tile) {
    const badges = tile.querySelectorAll(".media-badge");
    if (badges[0]) {
      badges[0].textContent = `${"\u{1F3A4}"} ${micOn ? "On" : "Off"}`;
    }
    if (badges[1]) {
      badges[1].textContent = `${"\u{1F4F9}"} ${camOn ? "On" : "Off"}`;
    }
  }
  if (state.user?.userId === userId) {
    const micLabel = document.querySelector("#toggleMicBtn .simple-label") as HTMLElement | null;
    const camLabel = document.querySelector("#toggleCamBtn .simple-label") as HTMLElement | null;
    if (micLabel) {
      micLabel.textContent = micOn ? "Mic On" : "Mic Off";
    }
    if (camLabel) {
      camLabel.textContent = camOn ? "Camera On" : "Camera Off";
    }
  }
}

function memberById(userId: string): RoomMember | undefined {
  return state.activeRoom?.members.find((member) => member.userId === userId);
}

function memberName(userId: string): string {
  return memberById(userId)?.name ?? "Guest";
}

function peersExpected(): string[] {
  if (!state.activeRoom || !state.user) {
    return [];
  }
  return state.activeRoom.members
    .map((member) => member.userId)
    .filter((userId) => userId !== state.user?.userId);
}

async function ensurePeerMeshConnections(): Promise<void> {
  if (!state.activeRoom || state.activeRoom.roomType !== "video" || !state.user) {
    return;
  }
  const expected = peersExpected();
  for (const peerId of expected) {
    const peer = peers.get(peerId);
    if (!peer) {
      if (state.user.userId < peerId) {
        await createOffer(peerId);
      }
      continue;
    }
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected" ||
      peer.connectionState === "closed"
    ) {
      removePeer(peerId);
      if (state.user.userId < peerId) {
        await createOffer(peerId);
      }
    }
  }
}

function startPeerSyncLoop(): void {
  if (peerSyncTimer) {
    window.clearInterval(peerSyncTimer);
  }
  peerSyncTimer = window.setInterval(() => {
    void ensurePeerMeshConnections();
  }, 2500);
}

function ensureVoiceAudioContext(): AudioContext | null {
  if (voiceAudioContext && voiceAudioContext.state !== "closed") {
    if (voiceAudioContext.state === "suspended") {
      void voiceAudioContext.resume();
    }
    return voiceAudioContext;
  }
  voiceAudioContext = new AudioContext();
  if (voiceAudioContext.state === "suspended") {
    void voiceAudioContext.resume();
  }
  return voiceAudioContext;
}

function setVoiceLevel(userId: string, level: number): void {
  voiceLevels.set(userId, level);
  const meterFill = document.querySelector(`[data-voice-meter="${userId}"] .voice-meter-fill`) as HTMLElement | null;
  if (meterFill) {
    meterFill.style.width = `${level}%`;
    meterFill.style.opacity = level > 2 ? "1" : "0.35";
  }
}

function refreshVoiceMeters(): void {
  for (const [userId, level] of voiceLevels.entries()) {
    setVoiceLevel(userId, level);
  }
}

function detachVoiceAnalyser(userId: string): void {
  const entry = voiceAnalysers.get(userId);
  if (!entry) {
    voiceLevels.delete(userId);
    return;
  }
  try {
    entry.source.disconnect();
  } catch {
    // no-op
  }
  try {
    entry.analyser.disconnect();
  } catch {
    // no-op
  }
  voiceAnalysers.delete(userId);
  voiceLevels.delete(userId);
}

function attachVoiceAnalyser(userId: string, stream: MediaStream): void {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return;
  }
  const ctx = ensureVoiceAudioContext();
  if (!ctx) {
    return;
  }
  detachVoiceAnalyser(userId);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  voiceAnalysers.set(userId, {
    source,
    analyser
  });
}

function startMicMeter(): void {
  if (micMeterFrame) {
    window.cancelAnimationFrame(micMeterFrame);
  }
  const animate = () => {
    for (const [userId, entry] of voiceAnalysers.entries()) {
      const data = new Uint8Array(entry.analyser.frequencyBinCount);
      entry.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        sum += data[i];
      }
      const avg = sum / data.length;
      const level = Math.min(100, Math.round((avg / 255) * 100));
      setVoiceLevel(userId, level);
    }
    micMeterFrame = window.requestAnimationFrame(animate);
  };
  micMeterFrame = window.requestAnimationFrame(animate);
}

async function loadMessages(reset = false): Promise<void> {
  if (!state.activeRoom) {
    return;
  }
  if (state.chatLoading) {
    return;
  }
  state.chatLoading = true;
  render();
  try {
    const beforeTs =
      reset || state.roomMessages.length === 0 ? "" : `&beforeTs=${state.roomMessages[0].ts}`;
    const data = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
      `/api/rooms/${state.activeRoom.roomId}/messages?limit=30${beforeTs}`
    );
    if (reset) {
      state.roomMessages = data.messages;
    } else {
      state.roomMessages = [...data.messages, ...state.roomMessages];
    }
    state.chatHasMore = data.hasMore;
  } catch {
    // Ignore transient history load failures
  } finally {
    state.chatLoading = false;
    render();
  }
}

function syncJoinRequestsFromRoom(room: RoomState): void {
  const roomRequests = room.pending.map((pending) => ({
    roomId: room.roomId,
    userId: pending.userId,
    name: pending.name
  }));
  const carryForward = state.joinRequests.filter((request) => request.roomId !== room.roomId);
  state.joinRequests = [...carryForward, ...roomRequests];
}

function cleanupRoomMedia(): void {
  peers.forEach((peer) => peer.close());
  peers.clear();
  remoteStreams.clear();
  pendingIceCandidates.clear();
  voiceAnalysers.forEach((entry) => {
    try {
      entry.source.disconnect();
    } catch {
      // no-op
    }
    try {
      entry.analyser.disconnect();
    } catch {
      // no-op
    }
  });
  voiceAnalysers.clear();
  voiceLevels.clear();
  if (peerSyncTimer) {
    window.clearInterval(peerSyncTimer);
    peerSyncTimer = null;
  }
  if (micMeterFrame) {
    window.cancelAnimationFrame(micMeterFrame);
    micMeterFrame = null;
  }
  if (voiceAudioContext) {
    voiceAudioContext.close().catch(() => {});
    voiceAudioContext = null;
  }
}

function stopLocalMedia(): void {
  if (!localStream) {
    return;
  }
  localStream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // no-op
    }
  });
  localStream = null;
}

function ensurePeerHasLocalTracks(peer: RTCPeerConnection): void {
  if (!localStream) {
    return;
  }
  const senderTrackIds = new Set(
    peer
      .getSenders()
      .map((sender) => sender.track?.id)
      .filter((id): id is string => Boolean(id))
  );
  localStream.getTracks().forEach((track) => {
    if (!senderTrackIds.has(track.id)) {
      peer.addTrack(track, localStream as MediaStream);
    }
  });
}

function attachLocalTracksToAllPeers(): void {
  peers.forEach((peer) => {
    ensurePeerHasLocalTracks(peer);
  });
}

async function flushPendingIceCandidates(peerId: string, peer: RTCPeerConnection): Promise<void> {
  const queued = pendingIceCandidates.get(peerId);
  if (!queued || queued.length === 0) {
    return;
  }
  pendingIceCandidates.delete(peerId);
  for (const candidate of queued) {
    try {
      await peer.addIceCandidate(candidate);
    } catch {
      // Candidate can be stale during renegotiation; ignore.
    }
  }
}

function initSocket(): void {
  if (!state.token) {
    return;
  }
  if (socket) {
    socket.disconnect();
  }

  socket = io(socketUrl, {
    auth: state.token ? { token: state.token } : undefined,
    withCredentials: true,
    autoConnect: true
  });

  socket.on("connect_error", (err) => {
    setNotice(`Socket error: ${err.message}`, "error");
  });

  socket.on("auth:error", (message: string) => {
    setNotice(message, "error");
  });

  socket.on("room:error", (message: string) => {
    setNotice(message, "error");
  });

  socket.on("room:pending", ({ message }: { message: string }) => {
    setNotice(message, "info");
  });

  socket.on("room:rejected", () => {
    setNotice("Join request was rejected by the admin.", "error");
  });

  socket.on("room:join-request", (request: JoinRequest) => {
    const exists = state.joinRequests.some(
      (current) => current.roomId === request.roomId && current.userId === request.userId
    );
    if (!exists) {
      state.joinRequests = [...state.joinRequests, request];
    }
    render();
  });

  socket.on("room:joined", async (room: RoomState) => {
    state.activeRoom = room;
    syncJoinRequestsFromRoom(room);
    state.localMicOn = memberById(state.user?.userId ?? "")?.micOn ?? true;
    state.localCamOn = memberById(state.user?.userId ?? "")?.camOn ?? true;
    state.chatHasMore = false;
    state.chatLoading = false;
    state.roomMessages = [];
    state.view = "room";
    state.roomNotice = "";
    render();
    if (room.roomType === "video") {
      await ensureLocalMedia();
      socket?.emit("room:media", {
        roomId: room.roomId,
        micOn: state.localMicOn,
        camOn: state.localCamOn
      });
      socket?.emit("room:sync-peers", { roomId: room.roomId });
      startPeerSyncLoop();
      void ensurePeerMeshConnections();
    }
    await loadMessages(true);
  });

  socket.on("room:state", (room: RoomState) => {
    if (!state.activeRoom || state.activeRoom.roomId !== room.roomId) {
      return;
    }
    const prev = state.activeRoom;
    state.activeRoom = room;
    syncJoinRequestsFromRoom(room);
    state.localMicOn = memberById(state.user?.userId ?? "")?.micOn ?? state.localMicOn;
    state.localCamOn = memberById(state.user?.userId ?? "")?.camOn ?? state.localCamOn;
    const sameMembers =
      prev.members.length === room.members.length &&
      prev.members.every((member, index) => member.userId === room.members[index]?.userId);
    const samePending = prev.pending.length === room.pending.length;
    const sameStructure =
      sameMembers &&
      samePending &&
      prev.adminId === room.adminId &&
      prev.label === room.label &&
      prev.mode === room.mode &&
      prev.roomType === room.roomType &&
      prev.maxUsers === room.maxUsers;
    if (state.view === "room" && sameStructure) {
      room.members.forEach((member) => {
        updateUserMediaDom(member.userId, member.micOn, member.camOn);
      });
    } else {
      render();
    }
    if (state.activeRoom.roomType === "video") {
      void ensurePeerMeshConnections();
    }
  });

  socket.on("room:message", (message: ChatMessage) => {
    if (!state.activeRoom || state.activeRoom.roomId !== message.roomId) {
      return;
    }
    state.roomMessages = [...state.roomMessages, message];
    if (!appendMessageToRoomDom(message)) {
      render();
    }
  });

  socket.on("room:user-left", ({ userId, roomId }: { userId: string; roomId: string }) => {
    if (!state.activeRoom || state.activeRoom.roomId !== roomId) {
      return;
    }
    removePeer(userId);
  });

  socket.on(
    "room:member-media",
    ({ userId, micOn, camOn }: { userId: string; micOn: boolean; camOn: boolean }) => {
      if (!state.activeRoom) {
        return;
      }
      state.activeRoom.members = state.activeRoom.members.map((member) =>
        member.userId === userId ? { ...member, micOn, camOn } : member
      );
      if (state.user?.userId === userId) {
        state.localMicOn = micOn;
        state.localCamOn = camOn;
      }
      updateUserMediaDom(userId, micOn, camOn);
    }
  );

  socket.on("room:admin-changed", ({ userId }: { userId: string }) => {
    if (!state.activeRoom) {
      return;
    }
    state.activeRoom.adminId = userId;
    render();
  });

  socket.on("room:peers", async ({ roomId, peers: peerIds }: { roomId: string; peers: string[] }) => {
    if (!state.activeRoom || state.activeRoom.roomId !== roomId) {
      return;
    }
    for (const peerId of peerIds) {
      if (state.user && state.user.userId < peerId) {
        await createOffer(peerId);
      }
    }
    await ensurePeerMeshConnections();
  });

  socket.on("room:user-joined", async ({ roomId, userId }: { roomId: string; userId: string }) => {
    if (!state.activeRoom || state.activeRoom.roomId !== roomId) {
      return;
    }
    if (!state.user || !state.activeRoom || state.activeRoom.roomType !== "video") {
      return;
    }
    if (state.user.userId < userId) {
      await createOffer(userId);
    }
    socket?.emit("room:sync-peers", { roomId });
  });

  socket.on("room:signal", async ({ from, roomId, signal }: { from: string; roomId: string; signal: SignalPayload }) => {
    if (!state.activeRoom || state.activeRoom.roomId !== roomId) {
      return;
    }
    if (state.activeRoom.roomType === "video" && !localStream) {
      await ensureLocalMedia();
    }
    if (isSessionDescription(signal) && signal.type === "offer") {
      await handleOffer(from, signal);
      return;
    }

    if (isSessionDescription(signal) && signal.type === "answer") {
      const peer = peers.get(from);
      if (peer) {
        await peer.setRemoteDescription(signal);
        await flushPendingIceCandidates(from, peer);
      }
      return;
    }

    if ("candidate" in signal) {
      const peer = peers.get(from) ?? buildPeer(from);
      if (peer.remoteDescription && peer.remoteDescription.type) {
        try {
          await peer.addIceCandidate(signal);
        } catch {
          const queued = pendingIceCandidates.get(from) ?? [];
          queued.push(signal);
          pendingIceCandidates.set(from, queued);
        }
      } else {
        const queued = pendingIceCandidates.get(from) ?? [];
        queued.push(signal);
        pendingIceCandidates.set(from, queued);
      }
    }
  });
}

async function ensureLocalMedia(): Promise<void> {
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = state.localMicOn;
    });
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = state.localCamOn;
    });
    if (state.user?.userId) {
      attachVoiceAnalyser(state.user.userId, localStream);
    }
    bindVideoStreams();
    startMicMeter();
    return;
  }
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = state.localMicOn;
  });
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = state.localCamOn;
  });
  if (state.user?.userId) {
    attachVoiceAnalyser(state.user.userId, localStream);
  }
  attachLocalTracksToAllPeers();
  bindVideoStreams();
  startMicMeter();
}

function buildPeer(peerId: string): RTCPeerConnection {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  peers.set(peerId, peer);

  ensurePeerHasLocalTracks(peer);

  peer.onicecandidate = (event) => {
    if (!event.candidate || !socket || !state.activeRoom) {
      return;
    }
    socket.emit("room:signal", {
      roomId: state.activeRoom.roomId,
      to: peerId,
      signal: event.candidate.toJSON()
    });
  };

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) {
      return;
    }
    remoteStreams.set(peerId, stream);
    attachVoiceAnalyser(peerId, stream);
    render();
    bindVideoStreams();
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "disconnected" || peer.connectionState === "failed") {
      removePeer(peerId);
    }
  };

  return peer;
}

function removePeer(peerId: string): void {
  peers.get(peerId)?.close();
  peers.delete(peerId);
  remoteStreams.delete(peerId);
  pendingIceCandidates.delete(peerId);
  detachVoiceAnalyser(peerId);
  render();
  bindVideoStreams();
}

async function createOffer(peerId: string): Promise<void> {
  if (!socket || !state.activeRoom) {
    return;
  }
  const peer = peers.get(peerId) ?? buildPeer(peerId);
  if (peer.signalingState !== "stable") {
    return;
  }
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit("room:signal", { roomId: state.activeRoom.roomId, to: peerId, signal: offer });
}

async function handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
  if (!socket || !state.activeRoom) {
    return;
  }
  const peer = peers.get(peerId) ?? buildPeer(peerId);
  if (peer.signalingState !== "stable") {
    try {
      await peer.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
    } catch {
      // ignore rollback support differences
    }
  }
  await peer.setRemoteDescription(offer);
  await flushPendingIceCandidates(peerId, peer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit("room:signal", { roomId: state.activeRoom.roomId, to: peerId, signal: answer });
}

function noticeHtml(): string {
  if (!state.roomNotice) {
    return "";
  }
  return `<p class="notice notice-${state.roomNoticeType}">${esc(state.roomNotice)}</p>`;
}

function landingHtml(): string {
  return `
    <section class="landing-page">
      <nav class="card landing-nav">
        <h3 class="brand">pico.chat</h3>
        <div class="landing-nav-links">
          <button type="button" class="nav-link" data-scroll-to="heroSection">Home</button>
          <button type="button" class="nav-link" data-scroll-to="featuresSection">Features</button>
          <button type="button" class="nav-link" data-scroll-to="howSection">How It Works</button>
          <button type="button" class="nav-link" data-scroll-to="trustSection">Trust</button>
          <button type="button" class="nav-link" data-scroll-to="testimonialsSection">Testimonials</button>
          <button type="button" class="nav-link" data-scroll-to="faqSection">FAQ</button>
        </div>
        <div class="row">
          <button type="button" class="btn ghost" data-go-auth="login">Login</button>
          <button type="button" class="btn" data-go-auth="signup">Get Started</button>
        </div>
      </nav>

      <section id="heroSection" class="screen landing-hero">
        <div class="hero card">
          <p class="eyebrow">Welcome to</p>
          <h1>pico.chat</h1>
          <p class="sub">
            Realtime text and video spaces with elegant pink and sky tones.
            Built for fast collaboration, clear calls and private team rooms.
          </p>
          <div class="row">
            <button type="button" class="btn" data-go-auth="signup">Create Free Account</button>
            <button type="button" class="btn ghost" data-go-auth="login">I Already Have an Account</button>
          </div>
          <div class="hero-pills">
            <span class="hero-pill">Duo + Group Rooms</span>
            <span class="hero-pill">Video + Text Together</span>
            <span class="hero-pill">Mongo + Redis Ready</span>
          </div>
        </div>
      </section>

      <section id="featuresSection" class="screen section-block features-block">
        <div class="section-head">
          <p class="eyebrow">Features</p>
          <h3>Everything you need in one room</h3>
        </div>
        <div class="grid feature-grid">
          <article class="card feature-card">
            <h4>Instant Rooms</h4>
            <p>Create duo or team rooms in seconds with one shareable code.</p>
          </article>
          <article class="card feature-card">
            <h4>Realtime Calls</h4>
            <p>Live mesh video, text side chat, emoji reactions, mic and camera indicators.</p>
          </article>
          <article class="card feature-card">
            <h4>Built to Scale</h4>
            <p>Mongo persistence, optional Redis cache, paginated history loading.</p>
          </article>
        </div>
      </section>

      <section id="howSection" class="screen section-block how-block">
        <div class="section-head">
          <p class="eyebrow">How It Works</p>
          <h3>Start, invite and collaborate in minutes</h3>
        </div>
        <div class="grid info-grid">
          <article class="card info-card">
            <h4>1. Create Your Space</h4>
            <p>Pick text or video mode, then choose duo or team room based on your session.</p>
          </article>
          <article class="card info-card">
            <h4>2. Invite with Room ID</h4>
            <p>Share a unique code to invite people quickly. Group admins can approve requests.</p>
          </article>
          <article class="card info-card">
            <h4>3. Collaborate Live</h4>
            <p>Use video, text, emoji, mic/camera controls and real-time room state updates.</p>
          </article>
        </div>
      </section>

      <section id="trustSection" class="screen section-block trust-block">
        <div class="section-head">
          <p class="eyebrow">Trust</p>
          <h3>Reliable and secure by design</h3>
        </div>
        <div class="grid trust-strip">
          <article class="card stat-card">
            <h3>Realtime</h3>
            <p>Socket-based chat, signaling and live room state.</p>
          </article>
          <article class="card stat-card">
            <h3>Secure Sessions</h3>
            <p>Token-authenticated room access and server-side verification.</p>
          </article>
          <article class="card stat-card">
            <h3>Performance Focus</h3>
            <p>Lazy message loading + Redis cache path for frequent room reads.</p>
          </article>
        </div>
      </section>

      <section id="testimonialsSection" class="screen section-block testimonials-block">
        <div class="section-head">
          <p class="eyebrow">Testimonials</p>
          <h3>What teams say about pico.chat</h3>
        </div>
        <div class="grid testimonials-grid">
          <article class="card testimonial-card">
            <p>
              "Our team moved from three tools into one. Video + text together is exactly what we
              needed."
            </p>
            <h4>Aryan P. | Product Team</h4>
          </article>
          <article class="card testimonial-card">
            <p>
              "The room code flow is super quick. We launch a room and start collaborating in under
              a minute."
            </p>
            <h4>Meera S. | Remote Ops</h4>
          </article>
          <article class="card testimonial-card">
            <p>
              "Clean UI, fast response, and the mic/camera status helps a lot during group calls."
            </p>
            <h4>Rahul D. | Engineering</h4>
          </article>
        </div>
      </section>

      <section id="faqSection" class="screen section-block faq-block">
        <div class="section-head">
          <p class="eyebrow">FAQ</p>
          <h3>Quick answers before you jump in</h3>
        </div>
        <div class="grid faq-grid">
          <article class="card faq-card">
            <h4>How many users can join one room?</h4>
            <p>Duo rooms allow 2 users. Group rooms allow up to 20 users.</p>
          </article>
          <article class="card faq-card">
            <h4>Can I use chat during video call?</h4>
            <p>Yes, every video room includes text chat and emoji reactions in the side panel.</p>
          </article>
          <article class="card faq-card">
            <h4>Is data persisted?</h4>
            <p>Yes, with MongoDB configured, users/rooms/messages persist across restarts.</p>
          </article>
        </div>
      </section>

      <footer class="card landing-footer">
        <p>pico.chat &bull; Beautiful, fast and collaborative communication.</p>
      </footer>
    </section>
  `;
}

function authHtml(): string {
  const signup = state.authMode === "signup";
  return `
    <section class="screen center">
      <div class="card auth-card">
        <h2>${signup ? "Create Account" : "Welcome Back"}</h2>
        <p class="sub">${signup ? "Join pico.chat in seconds" : "Login to continue"}</p>
        <form id="authForm" class="stack">
          ${signup ? '<input class="input" id="nameInput" placeholder="Name" required />' : ""}
          <input class="input" id="emailInput" type="email" placeholder="Email" required />
          <input class="input" id="passwordInput" type="password" placeholder="Password" required />
          <button class="btn" type="submit">${signup ? "Sign Up" : "Login"}</button>
        </form>
        <div class="row small-gap">
          <button type="button" class="btn ghost" data-switch-auth="${signup ? "login" : "signup"}">
            ${signup ? "Have account? Login" : "Need account? Sign Up"}
          </button>
          <button type="button" class="btn ghost" data-back-landing>Back</button>
        </div>
        ${noticeHtml()}
      </div>
    </section>
  `;
}

function dashboardHtml(): string {
  return `
    <section class="screen">
      <header class="card top">
        <div>
          <p class="eyebrow">pico.chat dashboard</p>
          <h2>Hey ${esc(state.user?.name ?? "")}</h2>
        </div>
        <button type="button" class="btn ghost" id="logoutBtn">Logout</button>
      </header>

      <div class="grid two">
        <article class="card option ${state.selectedRoomType === "text" ? "active" : ""}" data-room-type="text">
          <h3>Text Rooms</h3>
          <p>Duo chat or group chat up to 20 users.</p>
        </article>
        <article class="card option ${state.selectedRoomType === "video" ? "active" : ""}" data-room-type="video">
          <h3>Video Rooms</h3>
          <p>Video calling with side chat and emoji.</p>
        </article>
      </div>

      <section class="card setup">
        <h3>${state.selectedRoomType === "text" ? "Text Room Setup" : "Video Room Setup"}</h3>
        <div class="row">
          <button type="button" class="btn ${state.selectedRoomMode === "duo" ? "" : "ghost"}" data-room-mode="duo">Duo (2 users)</button>
          <button type="button" class="btn ${state.selectedRoomMode === "group" ? "" : "ghost"}" data-room-mode="group">Group (up to 20)</button>
        </div>
        <div class="grid two">
          <div class="card inner">
            <h4>Create unique room</h4>
            <input id="roomLabelInput" class="input" placeholder="Room name (optional)" />
            <button type="button" id="createRoomBtn" class="btn">Create Room</button>
          </div>
          <div class="card inner">
            <h4>Join with unique ID</h4>
            <input id="joinRoomInput" class="input" value="${esc(state.joinRoomCode)}" placeholder="Enter room ID e.g. A1B2C3" />
            <button type="button" id="joinRoomBtn" class="btn">Search & Join</button>
          </div>
        </div>
        ${
          state.joinRequests.length > 0
            ? `
          <div class="requests">
            <h4>Join requests</h4>
            ${state.joinRequests
              .map(
                (r) => `
              <div class="request-item">
                <span>${esc(r.name)} wants to join ${esc(r.roomId)}</span>
                <div class="row small-gap">
                  <button type="button" class="btn" data-approve="${r.userId}" data-room="${r.roomId}">Accept</button>
                  <button type="button" class="btn ghost" data-reject="${r.userId}" data-room="${r.roomId}">Reject</button>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        `
            : ""
        }
        ${noticeHtml()}
      </section>
    </section>
  `;
}

function roomHtml(): string {
  const room = state.activeRoom;
  if (!room) {
    return "";
  }
  const isAdmin = room.adminId === state.user?.userId;
  const emojiButtons = EMOJIS.map(
    (emoji) => `<button class="emoji-btn" data-emoji="${emoji}" type="button">${emoji}</button>`
  ).join("");
  const pendingInRoom = state.joinRequests.filter((request) => request.roomId === room.roomId);
  const messages = state.roomMessages
    .map(
      (m) => `
      <div class="msg ${m.userId === state.user?.userId ? "self" : ""}">
        <p>${esc(m.name)}</p>
        <span>${esc(m.text)}</span>
      </div>
    `
    )
    .join("");

  const remoteTiles = Array.from(remoteStreams.keys())
    .map(
      (peerId) => `
      <div class="video-box" data-user-id="${peerId}">
        <video id="remote-${peerId}" autoplay playsinline></video>
        <span class="video-tag">${esc(memberName(peerId))}</span>
        <div class="voice-meter-tile" data-voice-meter="${peerId}">
          <div class="voice-meter-fill"></div>
        </div>
        <div class="video-badges">
          <span class="media-badge">${memberById(peerId)?.micOn ? "\u{1F3A4} On" : "\u{1F3A4} Off"}</span>
          <span class="media-badge">${memberById(peerId)?.camOn ? "\u{1F4F9} On" : "\u{1F4F9} Off"}</span>
        </div>
      </div>
    `
    )
    .join("");

  return `
    <section class="screen">
      <header class="card top">
        <div>
          <p class="eyebrow">${room.roomType.toUpperCase()} ROOM</p>
          <h2>${esc(room.label)} (${esc(room.roomId)})</h2>
          <p class="sub">Mode: ${room.mode} | Members: ${room.members.length}/${room.maxUsers} | ${
    isAdmin ? "You are admin" : "Admin controls requests"
  }</p>
        </div>
        <div class="row">
          ${
            isAdmin && pendingInRoom.length > 0
              ? `<span class="pending-chip">${pendingInRoom.length} join request${pendingInRoom.length > 1 ? "s" : ""}</span>`
              : ""
          }
          <button type="button" class="btn ghost" id="copyIdBtn">Copy ID</button>
          <button type="button" class="btn ghost" id="leaveRoomBtn">Leave Room</button>
        </div>
      </header>

      ${
        isAdmin && pendingInRoom.length > 0
          ? `
        <section class="card requests room-requests">
          <h4>Pending Requests</h4>
          ${pendingInRoom
            .map(
              (request) => `
            <div class="request-item">
              <span>${esc(request.name)} wants to join</span>
              <div class="row small-gap">
                <button type="button" class="btn" data-approve="${request.userId}" data-room="${request.roomId}">Accept</button>
                <button type="button" class="btn ghost" data-reject="${request.userId}" data-room="${request.roomId}">Reject</button>
              </div>
            </div>
          `
            )
            .join("")}
        </section>
      `
          : ""
      }

      <div class="grid ${room.roomType === "video" ? "room-video" : "room-text"}">
        ${
          room.roomType === "video"
            ? `
          <section class="card stage">
            <div class="video-grid">
              <div class="video-box" data-user-id="${state.user?.userId ?? ""}">
                <video id="localVideo" autoplay muted playsinline></video>
                <span class="video-tag">You</span>
                <div class="voice-meter-tile" data-voice-meter="${state.user?.userId ?? ""}">
                  <div class="voice-meter-fill"></div>
                </div>
                <div class="video-badges">
                  <span class="media-badge">${state.localMicOn ? "\u{1F3A4} On" : "\u{1F3A4} Off"}</span>
                  <span class="media-badge">${state.localCamOn ? "\u{1F4F9} On" : "\u{1F4F9} Off"}</span>
                </div>
              </div>
              ${
                remoteTiles ||
                '<div class="video-empty">Waiting for other user video stream...</div>'
              }
            </div>
            <div class="controls-row">
              <div class="simple-controls" role="group" aria-label="Call controls">
                <button type="button" class="simple-control-btn" id="toggleMicBtn" aria-label="Toggle microphone">
                  <span class="simple-icon">&#127908;</span>
                  <span class="simple-label">${state.localMicOn ? "Mic On" : "Mic Off"}</span>
                </button>
                <button type="button" class="simple-control-btn" id="toggleCamBtn" aria-label="Toggle camera">
                  <span class="simple-icon">&#128249;</span>
                  <span class="simple-label">${state.localCamOn ? "Camera On" : "Camera Off"}</span>
                </button>
              </div>
            </div>
          </section>
        `
            : ""
        }
        <aside class="card chat-panel">
          <div class="messages">
            ${
              state.chatHasMore
                ? `<button type="button" class="btn ghost load-more-btn" id="loadOlderBtn" ${
                    state.chatLoading ? "disabled" : ""
                  }>${state.chatLoading ? "Loading..." : "Load older messages"}</button>`
                : ""
            }
            ${messages || '<p class="sub">No messages yet.</p>'}
          </div>
          <form id="messageForm" class="stack">
            <input id="messageInput" class="input" placeholder="Type a message..." />
            <div class="row small-gap wrap">${emojiButtons}</div>
            <button class="btn" type="submit">Send</button>
          </form>
        </aside>
      </div>

      ${noticeHtml()}
    </section>
  `;
}

function shellHtml(): string {
  return `
    <div class="scene" aria-hidden="true">
      <div class="blob blob-a"></div>
      <div class="blob blob-b"></div>
      <div class="blob blob-c"></div>
      <div class="mascot mascot-human"></div>
      <div class="mascot mascot-dog"></div>
      <div class="particles" id="particles"></div>
    </div>
    <main class="app-shell">
      ${
        state.view === "landing"
          ? landingHtml()
          : state.view === "auth"
            ? authHtml()
            : state.view === "dashboard"
              ? dashboardHtml()
              : roomHtml()
      }
    </main>
  `;
}

function bindVideoStreams(): void {
  const localVideo = document.querySelector("#localVideo") as HTMLVideoElement | null;
  if (localVideo && localStream) {
    localVideo.srcObject = localStream;
  }
  remoteStreams.forEach((stream, peerId) => {
    const video = document.querySelector(`#remote-${peerId}`) as HTMLVideoElement | null;
    if (video) {
      video.srcObject = stream;
    }
  });
  refreshVoiceMeters();
}

function bindEvents(): void {
  document.querySelectorAll("[data-scroll-to]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetId = (el as HTMLElement).dataset.scrollTo;
      if (!targetId) {
        return;
      }
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  document.querySelectorAll("[data-go-auth]").forEach((el) => {
    el.addEventListener("click", () => {
      const mode = (el as HTMLElement).dataset.goAuth as AuthMode;
      state.view = "auth";
      state.authMode = mode;
      state.roomNotice = "";
      render();
    });
  });

  document.querySelector("[data-back-landing]")?.addEventListener("click", () => {
    state.view = "landing";
    state.roomNotice = "";
    render();
  });

  document.querySelectorAll("[data-switch-auth]").forEach((el) => {
    el.addEventListener("click", () => {
      state.authMode = (el as HTMLElement).dataset.switchAuth as AuthMode;
      state.roomNotice = "";
      render();
    });
  });

  const authForm = document.querySelector("#authForm") as HTMLFormElement | null;
  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = (document.querySelector("#emailInput") as HTMLInputElement).value.trim();
    const password = (document.querySelector("#passwordInput") as HTMLInputElement).value;
    try {
      if (state.authMode === "signup") {
        const name = (document.querySelector("#nameInput") as HTMLInputElement).value.trim();
        await api("/api/signup", {
          method: "POST",
          body: JSON.stringify({ name, email, password })
        });
        state.authMode = "login";
        setNotice("Signup complete. Your account is ready, please login.", "success");
        return;
      }

      const data = await api<{ token: string; user: User }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      state.token = data.token;
      state.user = data.user;
      state.view = "dashboard";
      state.roomNotice = "";
      initSocket();
      render();
    } catch (error) {
      setNotice((error as Error).message, "error");
    }
  });

  document.querySelector("#logoutBtn")?.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      // no-op
    }
    socket?.disconnect();
    cleanupRoomMedia();
    stopLocalMedia();
    state.token = null;
    state.user = null;
    state.activeRoom = null;
    state.view = "landing";
    state.roomNotice = "";
    render();
  });

  document.querySelectorAll("[data-room-type]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedRoomType = (el as HTMLElement).dataset.roomType as RoomType;
      render();
    });
  });

  document.querySelectorAll("[data-room-mode]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedRoomMode = (el as HTMLElement).dataset.roomMode as RoomMode;
      render();
    });
  });

  document.querySelector("#createRoomBtn")?.addEventListener("click", async () => {
    const label = (document.querySelector("#roomLabelInput") as HTMLInputElement).value.trim();
    try {
      const data = await api<{ room: RoomState }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({
          roomType: state.selectedRoomType,
          mode: state.selectedRoomMode,
          label
        })
      });
      state.joinRoomCode = data.room.roomId;
      socket?.emit("room:request-join", { roomId: data.room.roomId });
      setNotice(`Room ${data.room.roomId} created successfully.`, "success");
    } catch (error) {
      setNotice((error as Error).message, "error");
    }
  });

  document.querySelector("#joinRoomBtn")?.addEventListener("click", () => {
    const roomId = (document.querySelector("#joinRoomInput") as HTMLInputElement).value.trim().toUpperCase();
    state.joinRoomCode = roomId;
    if (!roomId) {
      setNotice("Please enter a valid room ID.", "error");
      return;
    }
    socket?.emit("room:request-join", { roomId });
    setNotice(`Requesting access to room ${roomId}...`, "info");
  });

  document.querySelectorAll("[data-approve]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetUserId = (el as HTMLElement).dataset.approve as string;
      const roomId = (el as HTMLElement).dataset.room as string;
      socket?.emit("room:approve", { roomId, targetUserId, allow: true });
      state.joinRequests = state.joinRequests.filter((r) => r.userId !== targetUserId);
      render();
    });
  });

  document.querySelectorAll("[data-reject]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetUserId = (el as HTMLElement).dataset.reject as string;
      const roomId = (el as HTMLElement).dataset.room as string;
      socket?.emit("room:approve", { roomId, targetUserId, allow: false });
      state.joinRequests = state.joinRequests.filter((r) => r.userId !== targetUserId);
      render();
    });
  });

  document.querySelector("#copyIdBtn")?.addEventListener("click", async () => {
    if (!state.activeRoom) {
      return;
    }
    await navigator.clipboard.writeText(state.activeRoom.roomId);
    setNotice(`Copied room ID: ${state.activeRoom.roomId}`, "success");
  });

  document.querySelector("#leaveRoomBtn")?.addEventListener("click", () => {
    if (!state.activeRoom) {
      return;
    }
    socket?.emit("room:leave", { roomId: state.activeRoom.roomId });
    cleanupRoomMedia();
    stopLocalMedia();
    state.activeRoom = null;
    state.roomMessages = [];
    state.chatHasMore = false;
    state.chatLoading = false;
    state.view = "dashboard";
    state.roomNotice = "";
    render();
  });

  document.querySelector("#toggleMicBtn")?.addEventListener("click", () => {
    if (!state.activeRoom || !localStream) {
      return;
    }
    state.localMicOn = !state.localMicOn;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = state.localMicOn;
    });
    socket?.emit("room:media", {
      roomId: state.activeRoom.roomId,
      micOn: state.localMicOn
    });
    if (state.user?.userId) {
      updateUserMediaDom(state.user.userId, state.localMicOn, state.localCamOn);
    }
  });

  document.querySelector("#toggleCamBtn")?.addEventListener("click", () => {
    if (!state.activeRoom || !localStream) {
      return;
    }
    state.localCamOn = !state.localCamOn;
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = state.localCamOn;
    });
    socket?.emit("room:media", {
      roomId: state.activeRoom.roomId,
      camOn: state.localCamOn
    });
    if (state.user?.userId) {
      updateUserMediaDom(state.user.userId, state.localMicOn, state.localCamOn);
    }
  });

  document.querySelector("#loadOlderBtn")?.addEventListener("click", () => {
    void loadMessages(false);
  });

  const messageForm = document.querySelector("#messageForm") as HTMLFormElement | null;
  messageForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#messageInput") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !state.activeRoom) {
      return;
    }
    socket?.emit("room:message", { roomId: state.activeRoom.roomId, text });
    input.value = "";
  });

  document.querySelectorAll("[data-emoji]").forEach((el) => {
    el.addEventListener("click", () => {
      const input = document.querySelector("#messageInput") as HTMLInputElement | null;
      if (!input) {
        return;
      }
      input.value += (el as HTMLElement).dataset.emoji ?? "";
      input.focus();
    });
  });

  bindVideoStreams();
}

function animateDecor(): void {
  const particles = document.querySelector("#particles");
  if (!particles || particles.childElementCount > 0) {
    return;
  }
  for (let i = 0; i < 16; i += 1) {
    const dot = document.createElement("span");
    dot.className = "particle";
    particles.appendChild(dot);
    gsap.set(dot, {
      x: `${Math.random() * 100}vw`,
      y: `${Math.random() * 100}vh`,
      scale: 0.5 + Math.random()
    });
    gsap.to(dot, {
      y: `-=${80 + Math.random() * 200}`,
      x: `+=${-30 + Math.random() * 60}`,
      duration: 5 + Math.random() * 6,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
      delay: Math.random() * 2
    });
  }

  gsap.to(".mascot-human", {
    y: -20,
    rotation: 4,
    duration: 2.6,
    repeat: -1,
    yoyo: true,
    ease: "sine.inOut"
  });
  gsap.to(".mascot-dog", {
    y: -14,
    rotation: -6,
    duration: 2,
    repeat: -1,
    yoyo: true,
    ease: "sine.inOut"
  });
}

async function bootstrap(): Promise<void> {
  try {
    const data = await api<{ user: User }>("/api/me");
    state.user = data.user;
    state.view = "dashboard";
    initSocket();
  } catch {
    state.token = null;
    state.view = "landing";
  }
  render();
}

function render(): void {
  appRoot!.innerHTML = shellHtml();
  bindEvents();
  animateDecor();
}

bootstrap();






