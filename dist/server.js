// server.js
import express from "express";
import dotenv from "dotenv";
import { createClient } from "redis";
import { Server } from "socket.io";
import cors from "cors";
import http from "http";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { rateLimit } from "express-rate-limit";
import sharp from "sharp";
dotenv.config();
var app = express();
app.set("trust proxy", 1);
var globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 500,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later."
  }
});
var loginLimiter = rateLimit({
  windowMs: 1 * 1e3,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after some time."
  }
});
var imageUploadLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1e3,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterSeconds = Math.ceil(
      (req.rateLimit.resetTime?.getTime() - Date.now()) / 1e3
    );
    return res.status(429).json({
      success: false,
      code: "IMAGE_UPLOAD_RATE_LIMIT_REACHED",
      message: "Image upload limit reached. Please try again after some time.",
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? Math.max(retryAfterSeconds, 1) : 60
    });
  }
});
var imageFetchLimiter = rateLimit({
  windowMs: 1 * 1e3,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many image fetch events. Please try again after some time."
  }
});
var adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Try after some time."
  }
});
app.use(express.json({ limit: "50kb" }));
app.use(globalRateLimiter);
app.use(
  cors({
    origin: process.env.FRONTEND_URL
  })
);
var uploadRoot = path.resolve("uploads");
var chatImagesDir = path.join(uploadRoot, "chat-images");
fs.mkdirSync(chatImagesDir, { recursive: true });
app.use("/uploads", express.static(uploadRoot));
var imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, chatImagesDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "");
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeOriginalName}`;
    cb(null, uniqueName);
  }
});
async function optimizeChatImage(fileBuffer) {
  const optimizedBuffer = await sharp(fileBuffer, {
    failOn: "error"
  }).rotate().resize({
    width: MAX_IMAGE_WIDTH,
    height: MAX_IMAGE_HEIGHT,
    fit: "inside",
    withoutEnlargement: true
  }).webp({
    quality: IMAGE_QUALITY,
    effort: 4
  }).toBuffer();
  return {
    buffer: optimizedBuffer,
    mimeType: "image/webp",
    extension: "webp",
    size: optimizedBuffer.length
  };
}
var imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_IMAGE_BYTE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      cb(new Error("Only JPG, PNG, WEBP and GIF images are allowed"));
      return;
    }
    cb(null, true);
  }
});
function authenticateRestRequest(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token missing"
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid token"
    });
  }
}
var server = http.createServer(app);
var io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"]
  }
});
var currentRedisUrl = process.env.REDIS_URL;
function maskRedisUrl(redisUrl) {
  try {
    const parsedUrl = new URL(redisUrl);
    if (parsedUrl.username) parsedUrl.username = "****";
    if (parsedUrl.password) parsedUrl.password = "****";
    return parsedUrl.toString();
  } catch {
    return "Invalid Redis URL";
  }
}
function isValidRedisUrl(redisUrl) {
  try {
    const parsedUrl = new URL(redisUrl);
    return parsedUrl.protocol === "redis:" || parsedUrl.protocol === "rediss:";
  } catch {
    return false;
  }
}
function createRedisConnection(redisUrl) {
  const client = createClient({
    url: redisUrl
  });
  client.on("error", (err) => {
    console.log("Redis error:", err);
  });
  return client;
}
async function connectRedisClient(client) {
  if (!client.isOpen) {
    await client.connect();
  }
  await client.ping();
}
var redis = createRedisConnection(currentRedisUrl);
connectRedisClient(redis).then(async () => {
  await redis.del("online:users");
  console.log("Redis connected and old online users cleared");
}).catch((error) => {
  console.error("Initial Redis connection failed:", error);
  process.exit(1);
});
function authenticateAdminRequest(req, res, next) {
  const expectedSecret = process.env.ADMIN_CONFIG_SECRET;
  const receivedSecret = req.headers["x-admin-secret"];
  if (!expectedSecret) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_CONFIG_SECRET is not configured on the server"
    });
  }
  if (!receivedSecret || receivedSecret !== expectedSecret) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }
  next();
}
async function getOnlineUsersCount() {
  return await redis.sCard(keys.onlineUsers);
}
async function emitOnlineUsersCount() {
  const onlineUsers = await getOnlineUsersCount();
  io.emit("stats:online_users", {
    onlineUsers,
    updatedAt: Date.now()
  });
}
async function markUserOnline(userId, socketId) {
  await redis.sAdd(keys.onlineUsers, userId);
  await redis.sAdd(keys.userSocketIds(userId), socketId);
  await redis.expire(keys.userSocketIds(userId), 60 * 60);
}
async function markUserOfflineSocket(userId, socketId) {
  await redis.sRem(keys.userSocketIds(userId), socketId);
  const remainingSockets = await redis.sCard(keys.userSocketIds(userId));
  if (remainingSockets === 0) {
    await redis.sRem(keys.onlineUsers, userId);
    await redis.del(keys.userSocketIds(userId));
  }
}
app.get("/stats/online-users", async (req, res) => {
  const onlineUsers = await getOnlineUsersCount();
  return res.json({
    success: true,
    onlineUsers,
    socketMemoryCount: io.sockets.sockets.size,
    updatedAt: Date.now()
  });
});
app.get("/app/runtime-config", adminLimiter, async (req, res) => {
  return res.json({
    success: true,
    config: {
      isMaintenance: isMaintenanceMode,
      Match_Radius: MATCH_RADIUS_METERS
    },
    updatedAt: Date.now()
  });
});
app.post("/admin/runtime-config", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (process.env.ADMIN_CONFIG_SECRET && adminSecret !== process.env.ADMIN_CONFIG_SECRET) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }
    const { isMaintenance, Match_Radius } = req.query;
    const changes = {};
    if (typeof Match_Radius !== "undefined") {
      const newRadius = Number(Match_Radius);
      if (!Number.isFinite(newRadius) || newRadius <= 0 || newRadius > 150) {
        return res.status(400).json({
          success: false,
          message: "Match_Radius must be a valid positive number"
        });
      }
      MATCH_RADIUS_METERS = newRadius;
      changes.Match_Radius = MATCH_RADIUS_METERS;
      io.emit("app:runtime_config_updated", {
        isMaintenance: isMaintenanceMode,
        Match_Radius: MATCH_RADIUS_METERS,
        updatedAt: Date.now()
      });
    }
    if (typeof isMaintenance !== "undefined") {
      const nextMaintenanceValue = String(isMaintenance).toLowerCase() === "true";
      isMaintenanceMode = nextMaintenanceValue;
      changes.isMaintenance = isMaintenanceMode;
      if (isMaintenanceMode) {
        io.emit("app:maintenance", {
          isMaintenance: true,
          message: "Website is under maintenance. Please try again later.",
          updatedAt: Date.now()
        });
        await moveAllUsersOfflineForMaintenance();
        io.sockets.sockets.forEach((socket) => {
          socket.disconnect(true);
        });
        await emitOnlineUsersCount();
      } else {
        io.emit("app:maintenance", {
          isMaintenance: false,
          message: "Website is back online.",
          updatedAt: Date.now()
        });
      }
    }
    return res.json({
      success: true,
      message: "Runtime config updated",
      config: {
        isMaintenance: isMaintenanceMode,
        Match_Radius: MATCH_RADIUS_METERS
      },
      changes
    });
  } catch (error) {
    console.error("Runtime config update error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update runtime config"
    });
  }
});
var PORT = process.env.PORT;
var JWT_SECRET = process.env.JWT_SECRET;
var statsRoot = path.resolve("data");
var dailyLoginStatsFile = path.join(statsRoot, "daily-logins.json");
fs.mkdirSync(statsRoot, { recursive: true });
if (!fs.existsSync(dailyLoginStatsFile)) {
  fs.writeFileSync(dailyLoginStatsFile, JSON.stringify({}, null, 2), "utf-8");
}
var loginStatsWriteQueue = Promise.resolve();
function getTodayLoginDateKey() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
  return formatter.format(/* @__PURE__ */ new Date()).replace(/\//g, "-");
}
function dateKeyToTimestamp(dateKey) {
  console.log("Date Key:", dateKey);
  const [day, month, year] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}
function sortLoginStatsByDate(stats) {
  return Object.fromEntries(
    Object.entries(stats).sort(([dateA], [dateB]) => {
      console.log("dateA:", dateA, "dateB:", dateB);
      return dateKeyToTimestamp(dateA) - dateKeyToTimestamp(dateB);
    })
  );
}
async function readDailyLoginStats() {
  try {
    const fileContent = await fs.promises.readFile(dailyLoginStatsFile, "utf-8");
    if (!fileContent.trim()) {
      return {};
    }
    return JSON.parse(fileContent);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
async function writeDailyLoginStats(stats) {
  console.log("Stats:", stats);
  const sortedStats = sortLoginStatsByDate(stats);
  const tempFile = `${dailyLoginStatsFile}.tmp`;
  await fs.promises.writeFile(
    tempFile,
    JSON.stringify(sortedStats, null, 2),
    "utf-8"
  );
  await fs.promises.rename(tempFile, dailyLoginStatsFile);
  return sortedStats;
}
function recordDailyLogin() {
  loginStatsWriteQueue = loginStatsWriteQueue.then(async () => {
    const stats = await readDailyLoginStats();
    const todayKey = getTodayLoginDateKey();
    stats[todayKey] = Number(stats[todayKey] || 0) + 1;
    return await writeDailyLoginStats(stats);
  });
  return loginStatsWriteQueue;
}
var ROOM_CAPACITY = 2;
var isMaintenanceMode = false;
var MATCH_RADIUS_METERS = Number(process.env.MATCH_RADIUS_METERS || 51);
var OUT_OF_RADIUS_LIMIT = 5;
var MAX_UPLOAD_IMAGE_BYTE_SIZE = 4 * 1024 * 1024;
var MAX_IMAGE_WIDTH = 1280;
var MAX_IMAGE_HEIGHT = 1280;
var IMAGE_QUALITY = 75;
var keys = {
  waitingUsers: "waiting:users",
  usersGeo: "geo:users",
  onlineUsers: "online:users",
  userSocketIds: (userId) => `online:user:${userId}:sockets`,
  roomOutOfRadiusCount: (roomId, userId) => `room:${roomId}:oor:${userId}`,
  user: (userId) => `user:${userId}`,
  room: (roomId) => `room:${roomId}`,
  roomMembers: (roomId) => `room:${roomId}:members`,
  roomImages: (roomId) => `room:${roomId}:images`,
  chatImage: (imageId) => `chat:image:${imageId}`,
  userLock: (userId) => `lock:user:${userId}`,
  roomLock: (roomId) => `lock:room:${roomId}`
};
async function moveAllUsersOfflineForMaintenance() {
  const sockets = Array.from(io.sockets.sockets.values());
  for (const socket of sockets) {
    const userId = socket.data.userId;
    if (!userId) continue;
    socket.data.disconnectedByMaintenance = true;
    const user = await redis.hGetAll(keys.user(userId));
    if (user?.roomId) {
      await deleteRoomImages(user.roomId);
      await redis.del(keys.room(user.roomId));
      await redis.del(keys.roomMembers(user.roomId));
    }
    await redis.sRem(keys.waitingUsers, userId);
    await redis.zRem(keys.usersGeo, userId);
    await redis.hSet(keys.user(userId), {
      status: "offline",
      roomId: "",
      socketId: "",
      updatedAt: String(Date.now())
    });
  }
  await redis.del(keys.waitingUsers);
  await redis.del(keys.usersGeo);
}
async function disconnectAllUsersForRedisSwitch() {
  isMaintenanceMode = true;
  io.emit("app:maintenance", {
    isMaintenance: true,
    message: "Server is switching Redis connection. Please reconnect after a few seconds.",
    updatedAt: Date.now()
  });
  try {
    await moveAllUsersOfflineForMaintenance();
  } catch (error) {
    console.error("Failed to clean old Redis state before Redis switch:", error);
  }
  io.sockets.sockets.forEach((socket) => {
    socket.data.disconnectedByMaintenance = true;
    socket.disconnect(true);
  });
  await emitOnlineUsersCount();
}
function socketRoom(roomId) {
  return `room:${roomId}`;
}
function isValidLatLng(latitude, longitude) {
  return typeof latitude === "number" && typeof longitude === "number" && latitude >= -85.05112878 && latitude <= 85.05112878 && longitude >= -180 && longitude <= 180;
}
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function getHaversineDistanceInMeters(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METERS = 6371e3;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  return getDistanceInKm(lat1, lon1, lat2, lon2) * 1e3;
}
async function updateUserLocation(userId, latitude, longitude) {
  const now = Date.now();
  await redis.hSet(keys.user(userId), {
    latitude: String(latitude),
    longitude: String(longitude),
    updatedAt: String(now)
  });
  await redis.sendCommand([
    "GEOADD",
    keys.usersGeo,
    String(longitude),
    String(latitude),
    userId
  ]);
}
function createRoomId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
async function getSocketByUserId(userId) {
  const user = await redis.hGetAll(keys.user(userId));
  if (!user?.socketId) return null;
  return io.sockets.sockets.get(user?.socketId) || null;
}
async function acquireUserLocks(userAId, userBId) {
  const ids = [userAId, userBId].sort();
  const acquired = [];
  for (let id of ids) {
    let result = await redis.sendCommand([
      "SET",
      keys.userLock(id),
      "1",
      "NX",
      "EX",
      "5"
    ]);
    if (result !== "OK") {
      for (const acquiredId of acquired) {
        redis.del(keys.userLock(acquiredId));
      }
      return false;
    }
    acquired.push(id);
  }
  return true;
}
async function acquireRoomLock(roomId) {
  const result = await redis.sendCommand([
    "SET",
    keys.roomLock(roomId),
    "1",
    "NX",
    "EX",
    "5"
  ]);
  return result === "OK";
}
async function releaseUserLocks(userAId, userBId) {
  const ids = [userAId, userBId].sort();
  for (let id of ids) {
    await redis.del(keys.userLock(id));
  }
}
async function releaseRoomLock(roomId) {
  await redis.del(keys.roomLock(roomId));
}
async function createPairRoom(userAId, userBId) {
  const roomId = createRoomId();
  await redis.hSet(keys.room(roomId), {
    roomId,
    capacity: String(ROOM_CAPACITY),
    radius: String(MATCH_RADIUS_METERS),
    type: "Pair",
    createdAt: String(Date.now())
  });
  await redis.sAdd(keys.roomMembers(roomId), userAId);
  await redis.sAdd(keys.roomMembers(roomId), userBId);
  return roomId;
}
async function findNearbyWaitingUsersManual(userId, latitude, longitude, limit = 10) {
  const waitingUserIds = await redis.sMembers(keys.waitingUsers);
  const candidates = [];
  for (const candidateId of waitingUserIds) {
    if (!candidateId || candidateId === userId) {
      continue;
    }
    const candidateUser = await redis.hGetAll(keys.user(candidateId));
    if (!candidateUser || candidateUser.status !== "waiting") {
      continue;
    }
    const candidateLatitude = Number(candidateUser.latitude);
    const candidateLongitude = Number(candidateUser.longitude);
    if (!isValidLatLng(candidateLatitude, candidateLongitude)) {
      continue;
    }
    const distanceInMeters = getHaversineDistanceInMeters(
      latitude,
      longitude,
      candidateLatitude,
      candidateLongitude
    );
    if (distanceInMeters <= MATCH_RADIUS_METERS) {
      candidates.push({
        userId: candidateId,
        distanceInMeters,
        latitude: candidateLatitude,
        longitude: candidateLongitude,
        socketId: candidateUser.socketId
      });
    }
  }
  candidates.sort((a, b) => a.distanceInMeters - b.distanceInMeters);
  return candidates.slice(0, limit);
}
async function tryAutoMatch(socket) {
  const userId = socket.data.userId;
  const user = await redis.hGetAll(keys.user(userId));
  if (!user || user.status !== "waiting" || !user.latitude || !user.longitude) {
    return false;
  }
  const latitude = Number(user.latitude);
  const longitude = Number(user.longitude);
  const candidates = await findNearbyWaitingUsersManual(userId, latitude, longitude);
  for (const candidate of candidates) {
    const locked = await acquireUserLocks(userId, candidate.userId);
    if (!locked) {
      continue;
    }
    try {
      const latestUser = await redis.hGetAll(keys.user(userId));
      const latestCandidate = await redis.hGetAll(keys.user(candidate.userId));
      if (latestUser.status !== "waiting" || latestCandidate.status !== "waiting") {
        continue;
      }
      const candidateSocket = await getSocketByUserId(candidate.userId);
      if (!candidateSocket || !candidateSocket.connected) {
        await redis.sRem(keys.waitingUsers, candidate.userId);
        continue;
      }
      const distanceMeters = getDistanceInMeters(
        Number(latestUser.latitude),
        Number(latestUser.longitude),
        Number(latestCandidate.latitude),
        Number(latestCandidate.longitude)
      );
      if (distanceMeters > MATCH_RADIUS_METERS) {
        console.log("Inside if condition");
        continue;
      }
      const roomId = await createPairRoom(userId, candidate.userId);
      await redis.sRem(keys.waitingUsers, userId);
      await redis.sRem(keys.waitingUsers, candidate.userId);
      await redis.hSet(keys.user(userId), {
        status: "in_room",
        roomId,
        updatedAt: String(Date.now())
      });
      await redis.hSet(keys.user(candidate.userId), {
        status: "in_room",
        roomId,
        updatedAt: String(Date.now())
      });
      socket.leave("waiting");
      candidateSocket.leave("waiting");
      socket.join(socketRoom(roomId));
      candidateSocket.join(socketRoom(roomId));
      const members = [userId, candidate.userId];
      io.to(socketRoom(roomId)).emit("chat:matched", {
        roomId,
        members,
        radiusMeters: MATCH_RADIUS_METERS,
        distanceMeters: Number(distanceMeters.toFixed(2)),
        message: "Matched with a nearby user"
      });
      return true;
    } finally {
      await releaseUserLocks(userId, candidate.userId);
    }
  }
  return false;
}
async function closePairRoom({
  roomId,
  reason,
  offlineUserId = null,
  details = {}
}) {
  const locked = await acquireRoomLock(roomId);
  if (!locked) {
    return;
  }
  try {
    const members = await redis.sMembers(keys.roomMembers(roomId));
    if (!members.length) {
      await deleteRoomImages(roomId);
      await redis.del(keys.room(roomId));
      await redis.del(keys.roomMembers(roomId));
      return;
    }
    io.to(socketRoom(roomId)).emit("chat:ended", {
      roomId,
      reason,
      details,
      message: "Chat ended"
    });
    for (const memberId of members) {
      await redis.sRem(keys.roomMembers(roomId), memberId);
      const memberSocket = await getSocketByUserId(memberId);
      if (memberSocket) {
        memberSocket.leave(socketRoom(roomId));
      }
      if (memberId === offlineUserId) {
        await redis.sRem(keys.waitingUsers, memberId);
        await redis.zRem(keys.usersGeo, memberId);
        await redis.hSet(keys.user(memberId), {
          status: "offline",
          roomId: "",
          socketId: "",
          updatedAt: String(Date.now())
        });
        continue;
      }
      await redis.sAdd(keys.waitingUsers, memberId);
      await redis.hSet(keys.user(memberId), {
        status: "waiting",
        roomId: "",
        updatedAt: String(Date.now())
      });
      if (memberSocket && memberSocket.connected) {
        memberSocket.join("waiting");
        memberSocket.emit("waiting:joined", {
          userId: memberId,
          message: "You are moved back to waiting room"
        });
      }
    }
    await deleteRoomImages(roomId);
    await redis.del(keys.room(roomId));
    await redis.del(keys.roomMembers(roomId));
    for (const memberId of members) {
      if (memberId === offlineUserId) {
        continue;
      }
      const memberSocket = await getSocketByUserId(memberId);
      if (memberSocket && memberSocket.connected) {
        await tryAutoMatch(memberSocket);
      }
    }
  } finally {
    await releaseRoomLock(roomId);
  }
}
async function checkPairDistance(socket, latitude, longitude, accuracy) {
  const userId = socket.data.userId;
  const user = await redis.hGetAll(keys.user(userId));
  if (user.status !== "in_room" || !user.roomId) {
    return;
  }
  const roomId = user.roomId;
  const members = await redis.sMembers(keys.roomMembers(roomId));
  const otherUserId = members.find((id) => id !== userId);
  if (!otherUserId) {
    await closePairRoom({
      roomId,
      reason: "PAIR_USER_NOT_FOUND"
    });
    return;
  }
  const otherUser = await redis.hGetAll(keys.user(otherUserId));
  if (!otherUser?.latitude || !otherUser?.longitude) {
    await closePairRoom({
      roomId,
      reason: "OTHER_USER_LOCATION_NOT_FOUND"
    });
    return;
  }
  const distanceMeters = getDistanceInMeters(
    latitude,
    longitude,
    Number(otherUser.latitude),
    Number(otherUser.longitude)
  );
  console.log("distanceMeters while checking pair distance:", distanceMeters);
  const outOfRadiusKey = keys.roomOutOfRadiusCount(roomId, userId);
  if (distanceMeters > MATCH_RADIUS_METERS) {
    const outOfRadiusCount = await redis.incr(outOfRadiusKey);
    await redis.expire(outOfRadiusKey, 60);
    io.to(socketRoom(roomId)).emit("location:warning", {
      roomId,
      userId,
      distanceMeters: Number(distanceMeters.toFixed(2)),
      allowedRadiusMeters: MATCH_RADIUS_METERS,
      outOfRadiusCount,
      requiredCount: OUT_OF_RADIUS_LIMIT,
      message: "Possible GPS spike or user moved away"
    });
    if (outOfRadiusCount < OUT_OF_RADIUS_LIMIT) {
      console.log("Out of radius ignored temporarily:", {
        userId,
        distanceMeters,
        outOfRadiusCount
      });
      return;
    }
    await closePairRoom({
      roomId,
      reason: "OUT_OF_RADIUS",
      details: {
        movedUserId: userId,
        otherUserId,
        distanceMeters: Number(distanceMeters.toFixed(2)),
        allowedRadiusMeters: MATCH_RADIUS_METERS,
        outOfRadiusCount,
        accuracy
      }
    });
    return;
  }
  await redis.del(outOfRadiusKey);
  io.to(socketRoom(roomId)).emit("location:updated", {
    roomId,
    userId,
    latitude,
    longitude,
    distanceMeters: Number(distanceMeters.toFixed(2))
  });
}
async function deleteRoomImages(roomId) {
  try {
    const imageIds = await redis.sMembers(keys.roomImages(roomId));
    if (!imageIds.length) {
      await redis.del(keys.roomImages(roomId));
      return;
    }
    const imageKeys = imageIds.map((imageId) => keys.chatImage(imageId));
    await redis.del(imageKeys);
    await redis.del(keys.roomImages(roomId));
    console.log("Deleted Redis chat images:", {
      roomId,
      count: imageIds.length
    });
  } catch (error) {
    console.error("deleteRoomImages error:", error);
  }
}
app.post("/auth/login", loginLimiter, async (req, res) => {
  if (isMaintenanceMode) {
    return res.status(503).json({
      success: false,
      isMaintenance: true,
      message: "Website is under maintenance. Please try again later."
    });
  }
  try {
    const { userId, name, latitude, longitude } = req.body;
    if (!userId || !isValidLatLng(latitude, longitude)) {
      return res.status(400).json({
        message: "userId, valid latitude and valid longitude are required"
      });
    }
    const now = Date.now();
    await redis.hSet(keys.user(userId), {
      userId,
      name: name || "",
      latitude: String(latitude),
      longitude: String(longitude),
      status: "waiting",
      roomId: "",
      socketId: "",
      updatedAt: String(now)
    });
    await redis.sAdd(keys.waitingUsers, userId);
    await redis.sendCommand([
      "GEOADD",
      keys.usersGeo,
      String(longitude),
      String(latitude),
      userId
    ]);
    await recordDailyLogin();
    const token = jwt.sign({ userId }, JWT_SECRET, {
      expiresIn: "24h"
    });
    return res.json({
      message: "Login successful",
      token,
      user: {
        userId,
        name,
        status: "waiting",
        latitude,
        longitude
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      message: "Internal server error"
    });
  }
});
io.use((socket, next) => {
  try {
    if (isMaintenanceMode) {
      return next(new Error("Website is under maintenance. Please try again later."));
    }
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication token missing"));
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.userId = decoded.userId;
    next();
  } catch (error) {
    return next(new Error("Invalid token"));
  }
});
app.post(
  "/messages/image",
  imageUploadLimiter,
  authenticateRestRequest,
  imageUpload.single("image"),
  async (req, res) => {
    try {
      const userId = req.userId;
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required"
        });
      }
      const user = await redis.hGetAll(keys.user(userId));
      if (user.status !== "in_room" || !user.roomId) {
        return res.status(400).json({
          success: false,
          message: "You are not connected to any chat room"
        });
      }
      const imageId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const imageKey = keys.chatImage(imageId);
      const roomImagesKey = keys.roomImages(user.roomId);
      let optimizedImage;
      try {
        optimizedImage = await optimizeChatImage(req.file.buffer);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: "Unsupported image type uploaded"
        });
      }
      const imageBase64 = optimizedImage.buffer.toString("base64");
      await redis.hSet(imageKey, {
        imageId,
        roomId: user.roomId,
        from: userId,
        mimeType: optimizedImage.mimeType,
        fileName: `${imageId}.${optimizedImage.extension}`,
        originalMimeType: req.file.mimetype,
        originalFileName: req.file.originalname,
        originalSize: String(req.file.size),
        size: String(optimizedImage.size),
        data: imageBase64,
        createdAt: String(Date.now())
      });
      await redis.expire(imageKey, 60 * 60);
      await redis.sAdd(roomImagesKey, imageId);
      await redis.expire(roomImagesKey, 60 * 60);
      const imageUrl = `${req.protocol}://${req.get(
        "host"
      )}/api/messages/image/${imageId}`;
      const message = {
        roomId: user.roomId,
        from: userId,
        type: "image",
        imageId,
        imageUrl,
        fileName: `${imageId}.${optimizedImage.extension}`,
        mimeType: optimizedImage.mimeType,
        size: optimizedImage.size,
        originalFileName: req.file.originalname,
        originalSize: req.file.size,
        clientMessageId: req.body.clientMessageId || null,
        sentAt: Date.now()
      };
      io.to(socketRoom(user.roomId)).emit("message:new", message);
      return res.json({
        success: true,
        message: "Image sent",
        data: message
      });
    } catch (error) {
      console.error("Image upload error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to send image"
      });
    }
  }
);
app.get("/api/messages/image/:imageId", imageFetchLimiter, async (req, res) => {
  try {
    const { imageId } = req.params;
    const image = await redis.hGetAll(keys.chatImage(imageId));
    if (!image || !image.data) {
      return res.status(404).json({
        success: false,
        message: "Image not found or expired"
      });
    }
    const imageBuffer = Buffer.from(image.data, "base64");
    res.setHeader("Content-Type", image.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(imageBuffer);
  } catch (error) {
    console.error("Image fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch image"
    });
  }
});
app.get("/stats/daily-logins", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (process.env.ADMIN_CONFIG_SECRET && adminSecret !== process.env.ADMIN_CONFIG_SECRET) {
      return res.status(401).json({
        success: false,
        message: "Unauthorised"
      });
    }
    const stats = await readDailyLoginStats();
    const sortedStats = sortLoginStatsByDate(stats);
    return res.json({
      success: true,
      data: sortedStats,
      updatedAt: Date.now()
    });
  } catch (error) {
    console.error("Daily login stats fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch daily login stats"
    });
  }
});
app.post(
  "/admin/redis-url",
  adminLimiter,
  authenticateAdminRequest,
  async (req, res) => {
    let newRedis = null;
    try {
      const { redisUrl } = req.body || {};
      if (!redisUrl || typeof redisUrl !== "string") {
        return res.status(400).json({
          success: false,
          message: "redisUrl is required"
        });
      }
      const trimmedRedisUrl = redisUrl.trim();
      if (!isValidRedisUrl(trimmedRedisUrl)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Redis URL. URL must start with redis:// or rediss://"
        });
      }
      if (trimmedRedisUrl === currentRedisUrl) {
        return res.json({
          success: true,
          message: "Redis URL is already using the provided value",
          redis: {
            url: maskRedisUrl(currentRedisUrl)
          }
        });
      }
      newRedis = createRedisConnection(trimmedRedisUrl);
      await connectRedisClient(newRedis);
      const oldRedis = redis;
      await disconnectAllUsersForRedisSwitch();
      redis = newRedis;
      currentRedisUrl = trimmedRedisUrl;
      process.env.REDIS_URL = trimmedRedisUrl;
      await redis.del(keys.onlineUsers);
      try {
        if (oldRedis?.isOpen) {
          await oldRedis.quit();
        }
      } catch (error) {
        console.error("Old Redis quit error:", error);
        try {
          oldRedis.disconnect();
        } catch {
        }
      }
      isMaintenanceMode = false;
      return res.json({
        success: true,
        message: "Redis URL changed successfully. Existing users were disconnected and must login again.",
        redis: {
          url: maskRedisUrl(currentRedisUrl),
          changedAt: Date.now()
        }
      });
    } catch (error) {
      console.error("Redis URL change error:", error);
      if (newRedis?.isOpen) {
        try {
          await newRedis.quit();
        } catch {
        }
      }
      isMaintenanceMode = false;
      return res.status(500).json({
        success: false,
        message: "Failed to change Redis URL"
      });
    }
  }
);
io.on("connection", async (socket) => {
  const userId = socket.data.userId;
  console.log("Socket connected:", socket.id, userId);
  const user = await redis.hGetAll(keys.user(userId));
  if (!user || !user.userId) {
    socket.emit("auth:error", {
      message: "User session not found. Please login again."
    });
    socket.disconnect();
    return;
  }
  await markUserOnline(userId, socket.id);
  await redis.hSet(keys.user(userId), {
    socketId: socket.id,
    status: user.status === "in_room" ? "in_room" : "waiting",
    updatedAt: String(Date.now())
  });
  await emitOnlineUsersCount();
  if (user.status === "in_room" && user.roomId) {
    socket.join(socketRoom(user.roomId));
    socket.emit("room:rejoined", {
      roomId: user.roomId,
      message: "Reconnected to existing room"
    });
  } else {
    socket.join("waiting");
    await redis.sAdd(keys.waitingUsers, userId);
    socket.emit("waiting:joined", {
      userId,
      message: "You are in waiting room"
    });
    await tryAutoMatch(socket);
  }
  socket.on("location:update", async (payload, ack) => {
    try {
      const { latitude, longitude, accuracy } = payload || {};
      if (!isValidLatLng(latitude, longitude)) {
        const response2 = {
          success: false,
          message: "Valid latitude and longitude are required"
        };
        if (ack) ack(response2);
        return;
      }
      await updateUserLocation(userId, latitude, longitude);
      const latestUser = await redis.hGetAll(keys.user(userId));
      if (latestUser.status === "in_room") {
        await checkPairDistance(socket, latitude, longitude, accuracy);
      } else {
        await redis.hSet(keys.user(userId), {
          status: "waiting",
          roomId: "",
          updatedAt: String(Date.now())
        });
        await redis.sAdd(keys.waitingUsers, userId);
        socket.join("waiting");
        await tryAutoMatch(socket);
      }
      const response = {
        success: true,
        message: "Location updated"
      };
      if (ack) ack(response);
    } catch (error) {
      console.error("location:update error:", error);
      const response = {
        success: false,
        message: "Failed to update location"
      };
      if (ack) ack(response);
    }
  });
  socket.on("room:leave", async (_, ack) => {
    try {
      const user2 = await redis.hGetAll(keys.user(userId));
      if (user2.status !== "in_room" || !user2.roomId) {
        const response2 = {
          success: false,
          message: "User is not inside any room"
        };
        if (ack) ack(response2);
        return;
      }
      await closePairRoom({
        roomId: user2.roomId,
        reason: "USER_LEFT",
        details: {
          userId
        }
      });
      const response = {
        success: true,
        message: "Chat ended and users moved back to waiting room"
      };
      if (ack) ack(response);
    } catch (error) {
      console.error("room:leave error:", error);
      if (ack) {
        ack({
          success: false,
          message: "Failed to leave room"
        });
      }
    }
  });
  socket.on("disconnect", async () => {
    try {
      console.log("Socket disconnected:", socket.id, userId);
      if (socket.data.disconnectedByMaintenance || isMaintenanceMode) {
        return;
      }
      const user2 = await redis.hGetAll(keys.user(userId));
      if (user2.status === "in_room" && user2.roomId) {
        await closePairRoom({
          roomId: user2.roomId,
          reason: "USER_DISCONNECTED",
          offlineUserId: userId,
          details: {
            userId
          }
        });
        return;
      }
      await redis.sRem(keys.waitingUsers, userId);
      await redis.zRem(keys.usersGeo, userId);
      await redis.hSet(keys.user(userId), {
        status: "offline",
        socketId: "",
        roomId: "",
        updatedAt: String(Date.now())
      });
    } catch (error) {
      console.error("disconnect error:", error);
    } finally {
      await markUserOfflineSocket(userId, socket.id);
      await emitOnlineUsersCount();
    }
  });
  socket.on("message:send", async (payload, ack) => {
    try {
      const { text, clientMessageId } = payload || {};
      if (!text || typeof text !== "string" || !text.trim()) {
        const response2 = {
          success: false,
          message: "Message text is required"
        };
        if (ack) ack(response2);
        return;
      }
      const user2 = await redis.hGetAll(keys.user(userId));
      if (user2.status !== "in_room" || !user2.roomId) {
        const response2 = {
          success: false,
          message: "You are not connected to any chat room"
        };
        if (ack) ack(response2);
        return;
      }
      const message = {
        roomId: user2.roomId,
        from: userId,
        text: text.trim(),
        clientMessageId: clientMessageId || null,
        sentAt: Date.now()
      };
      io.to(socketRoom(user2.roomId)).emit("message:new", message);
      const response = {
        success: true,
        message: "Message sent"
      };
      if (ack) ack(response);
    } catch (error) {
      console.error("message:send error:", error);
      if (ack) {
        ack({
          success: false,
          message: "Failed to send message"
        });
      }
    }
  });
});
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "Image is too large. Maximum allowed size is 4 MB."
      });
    }
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  if (error.message?.includes("Only JPG")) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  next(error);
});
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
