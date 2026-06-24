import express from 'express';
import dotenv from "dotenv";
import { createClient } from 'redis';
import { Server } from 'socket.io';
import cors from 'cors';
import http from 'http';
import jwt from 'jsonwebtoken';
import multer from "multer";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express()

app.use(express.json());

app.use(
  cors({
    // origin: process.env.FRONTEND_URL || '*'
    origin: '*'
  })
)

const uploadRoot = path.resolve("uploads");
const chatImagesDir = path.join(uploadRoot, "chat-images");

fs.mkdirSync(chatImagesDir, { recursive: true });

app.use("/uploads", express.static(uploadRoot));

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, chatImagesDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = file.originalname
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9.\-_]/g, "");

    const uniqueName = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}-${safeOriginalName}`;

    cb(null, uniqueName);
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB recommended for Redis
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if (!allowedTypes.includes(file.mimetype)) {
      cb(new Error("Only JPG, PNG, WEBP and GIF images are allowed"));
      return;
    }

    cb(null, true);
  },
});

function authenticateRestRequest(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token missing",
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, JWT_SECRET);

    req.userId = decoded.userId;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    // origin: process.env.FRONTEND_URL || '*',
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const redis = createClient({
  url: process.env.REDIS_URL
})

redis.on("error", (err) => {
  console.log("Error in redis:", err);
})

redis.connect().then(async () => {
  await redis.del("online:users");
  console.log("Redis connected and old online users cleared");
});

async function getOnlineUsersCount() {
  return await redis.sCard(keys.onlineUsers);
}

async function emitOnlineUsersCount() {
  const onlineUsers = await getOnlineUsersCount();

  console.log("[stats emit] online users:", onlineUsers);

  io.emit("stats:online_users", {
    onlineUsers,
    updatedAt: Date.now(),
  });
}

async function markUserOnline(userId, socketId) {
  await redis.sAdd(keys.onlineUsers, userId);
  await redis.sAdd(keys.userSocketIds(userId), socketId);

  // Safety expiry in case server crashes before disconnect cleanup.
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
    updatedAt: Date.now(),
  });
});

const PORT = process.env.PORT;
const JWT_SECRET = process.env.JWT_SECRET;

const ROOM_CAPACITY = 2;
const MATCH_RADIUS_METERS = 50 + 1;
const OUT_OF_RADIUS_LIMIT = 5;

const keys = {
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
  roomLock: (roomId) => `lock:room:${roomId}`,
};

function socketRoom(roomId) {
  return `room:${roomId}`;
}

function isValidLatLng(latitude, longitude) {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    latitude >= -85.05112878 &&
    latitude <= 85.05112878 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getHaversineDistanceInMeters(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METERS = 6371000;

  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) *
    Math.cos(rLat2) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  return getDistanceInKm(lat1, lon1, lat2, lon2) * 1000;
}

async function updateUserLocation(userId, latitude, longitude) {
  const now = Date.now();

  await redis.hSet(keys.user(userId), {
    latitude: String(latitude),
    longitude: String(longitude),
    updatedAt: String(now),
  });

  await redis.sendCommand([
    "GEOADD",
    keys.usersGeo,
    String(longitude),
    String(latitude),
    userId,
  ]);
}

function createRoomId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
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
    ])

    if (result !== "OK") {
      for (const acquiredId of acquired) {
        redis.del(keys.userLock(acquiredId))
      }
      return false;
    }

    acquired.push(id)
  }
  return true
}

async function acquireRoomLock(roomId) {
  const result = await redis.sendCommand([
    "SET",
    keys.roomLock(roomId),
    "1",
    "NX",
    "EX",
    "5"
  ])

  return result === "OK";
}

async function releaseUserLocks(userAId, userBId) {
  const ids = [userAId, userBId].sort();
  for (let id of ids) {
    await redis.del(keys.userLock(id))
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
  })

  await redis.sAdd(keys.roomMembers(roomId), userAId);
  await redis.sAdd(keys.roomMembers(roomId), userBId);

  return roomId
}

async function findNearbyWaitingUsers(userId, latitude, longitude) {
  const rawUsers = await redis.sendCommand([
    "GEOSEARCH",
    keys.usersGeo,
    "FROMLONLAT",
    String(longitude),
    String(latitude),
    "BYRADIUS",
    String(MATCH_RADIUS_METERS),
    "m",
    "WITHDIST",
    "ASC",
    "COUNT",
    "10"
  ])

  console.log("Nearby users:", rawUsers)

  let candidates = [];
  // console.log("rawUsers:", rawUsers)
  for (const eachUser of rawUsers) {
    const candidateId = eachUser[0];
    const distanceInMeters = Number(eachUser[1]);

    if (candidateId === userId) continue;
    // console.log("User ID :", userId);
    const waitingUser = await redis.sIsMember(keys.waitingUsers, candidateId);
    // console.log("Waiting user:", waitingUser)
    if (!waitingUser) continue;

    const candidateUser = await redis.hGetAll(keys.user(candidateId));

    if (!candidateId) continue;

    candidates.push({
      userId: candidateId,
      distanceInMeters,
      latitude: Number(candidateUser.latitude),
      longitude: Number(candidateUser.longitude),
      socketId: candidateUser.socketId
    })
  }

  return candidates;
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

    console.log("Manual distance check:", {
      currentUserId: userId,
      candidateId,
      distanceInMeters,
      allowedRadiusMeters: MATCH_RADIUS_METERS,
    });

    if (distanceInMeters <= MATCH_RADIUS_METERS) {
      candidates.push({
        userId: candidateId,
        distanceInMeters,
        latitude: candidateLatitude,
        longitude: candidateLongitude,
        socketId: candidateUser.socketId,
      });
    }
  }

  candidates.sort((a, b) => a.distanceInMeters - b.distanceInMeters);

  return candidates.slice(0, limit);
}

async function tryAutoMatch(socket) {
  const userId = socket.data.userId;

  const user = await redis.hGetAll(keys.user(userId));

  if (
    !user ||
    user.status !== "waiting" ||
    !user.latitude ||
    !user.longitude
  ) {
    return false;
  }

  const latitude = Number(user.latitude);
  const longitude = Number(user.longitude);
  // console.log("Current user location:", {
  //     userId,
  //     latitude,
  //     longitude,
  //   });

  // Commented for testing purpose
  // const candidates = await findNearbyWaitingUsers(userId, latitude, longitude);

  // Manual calculation
  const candidates = await findNearbyWaitingUsersManual(userId, latitude, longitude);

  // console.log("Candidates:", candidates)
  for (const candidate of candidates) {
    const locked = await acquireUserLocks(userId, candidate.userId);

    if (!locked) {
      continue;
    }

    try {
      const latestUser = await redis.hGetAll(keys.user(userId));
      const latestCandidate = await redis.hGetAll(keys.user(candidate.userId));

      if (
        latestUser.status !== "waiting" ||
        latestCandidate.status !== "waiting"
      ) {
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

      console.log("Distance in meters:", distanceMeters)

      if (distanceMeters > MATCH_RADIUS_METERS) {
        console.log("Inside if condition")
        continue;
      }

      const roomId = await createPairRoom(userId, candidate.userId);

      await redis.sRem(keys.waitingUsers, userId);
      await redis.sRem(keys.waitingUsers, candidate.userId);

      await redis.hSet(keys.user(userId), {
        status: "in_room",
        roomId,
        updatedAt: String(Date.now()),
      });

      await redis.hSet(keys.user(candidate.userId), {
        status: "in_room",
        roomId,
        updatedAt: String(Date.now()),
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
        message: "Matched with a nearby user",
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
  details = {},
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
      message: "Chat ended",
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
          updatedAt: String(Date.now()),
        });

        continue;
      }

      await redis.sAdd(keys.waitingUsers, memberId);

      await redis.hSet(keys.user(memberId), {
        status: "waiting",
        roomId: "",
        updatedAt: String(Date.now()),
      });

      if (memberSocket && memberSocket.connected) {
        memberSocket.join("waiting");

        memberSocket.emit("waiting:joined", {
          userId: memberId,
          message: "You are moved back to waiting room",
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
      reason: "PAIR_USER_NOT_FOUND",
    });

    return;
  }

  const otherUser = await redis.hGetAll(keys.user(otherUserId));

  if (!otherUser?.latitude || !otherUser?.longitude) {
    await closePairRoom({
      roomId,
      reason: "OTHER_USER_LOCATION_NOT_FOUND",
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
      message: "Possible GPS spike or user moved away",
    });

    if (outOfRadiusCount < OUT_OF_RADIUS_LIMIT) {
      console.log("Out of radius ignored temporarily:", {
        userId,
        distanceMeters,
        outOfRadiusCount,
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
        accuracy,
      },
    });

    return;
  }
  await redis.del(outOfRadiusKey);

  io.to(socketRoom(roomId)).emit("location:updated", {
    roomId,
    userId,
    latitude,
    longitude,
    distanceMeters: Number(distanceMeters.toFixed(2)),
  });
}

// async function deleteRoomImages(roomId) {
//   try {
//     const imageFilenames = await redis.sMembers(keys.roomImages(roomId));

//     if (!imageFilenames.length) {
//       await redis.del(keys.roomImages(roomId));
//       return;
//     }

//     await Promise.all(
//       imageFilenames.map(async (filename) => {
//         const safeFileName = path.basename(filename);
//         const filePath = path.join(chatImagesDir, safeFileName);

//         try {
//           await fs.promises.unlink(filePath);
//           console.log("Deleted chat image:", filePath);
//         } catch (error) {
//           if (error.code !== "ENOENT") {
//             console.error("Failed to delete chat image:", filePath, error);
//           }
//         }
//       })
//     );

//     await redis.del(keys.roomImages(roomId));
//   } catch (error) {
//     console.error("deleteRoomImages error:", error);
//   }
// }

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
      count: imageIds.length,
    });
  } catch (error) {
    console.error("deleteRoomImages error:", error);
  }
}

/**
 * Only REST API.
 * User logs in and is marked as waiting.
 */
app.post("/auth/login", async (req, res) => {
  try {
    const { userId, name, latitude, longitude } = req.body;

    if (!userId || !isValidLatLng(latitude, longitude)) {
      return res.status(400).json({
        message: "userId, valid latitude and valid longitude are required",
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
      updatedAt: String(now),
    });

    await redis.sAdd(keys.waitingUsers, userId);

    await redis.sendCommand([
      "GEOADD",
      keys.usersGeo,
      String(longitude),
      String(latitude),
      userId,
    ]);

    const token = jwt.sign({ userId }, JWT_SECRET, {
      expiresIn: "24h",
    });

    return res.json({
      message: "Login successful",
      token,
      user: {
        userId,
        name,
        status: "waiting",
        latitude,
        longitude,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
});
/**
 * Socket authentication.
 */
io.use((socket, next) => {
  try {
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

const sendImageMessageHandler = async (req, res) => {
  try {
    const userId = req.userId;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image file is required",
      });
    }

    const user = await redis.hGetAll(keys.user(userId));

    if (user.status !== "in_room" || !user.roomId) {
      fs.unlink(req.file.path, () => { });

      return res.status(400).json({
        success: false,
        message: "You are not connected to any chat room",
      });
    }

    await redis.sAdd(keys.roomImages(user.roomId), req.file.filename);
    await redis.expire(keys.roomImages(user.roomId), 60 * 60);

    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/chat-images/${req.file.filename}`;

    const message = {
      roomId: user.roomId,
      from: userId,
      type: "image",
      imageUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      clientMessageId: req.body.clientMessageId || null,
      sentAt: Date.now(),
    };

    io.to(socketRoom(user.roomId)).emit("message:new", message);

    return res.json({
      success: true,
      message: "Image sent",
      data: message,
    });
  } catch (error) {
    console.error("Image upload error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send image",
    });
  }
};

// app.post(
//   "/messages/image",
//   authenticateRestRequest,
//   imageUpload.single("image"),
//   sendImageMessageHandler
// );

app.post(
  "/messages/image",
  authenticateRestRequest,
  imageUpload.single("image"),
  async (req, res) => {
    try {
      const userId = req.userId;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required",
        });
      }

      const user = await redis.hGetAll(keys.user(userId));

      if (user.status !== "in_room" || !user.roomId) {
        return res.status(400).json({
          success: false,
          message: "You are not connected to any chat room",
        });
      }

      const imageId = `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;

      const imageKey = keys.chatImage(imageId);
      const roomImagesKey = keys.roomImages(user.roomId);

      const imageBase64 = req.file.buffer.toString("base64");

      await redis.hSet(imageKey, {
        imageId,
        roomId: user.roomId,
        from: userId,
        mimeType: req.file.mimetype,
        fileName: req.file.originalname,
        size: String(req.file.size),
        data: imageBase64,
        createdAt: String(Date.now()),
      });

      await redis.expire(imageKey, 60 * 60); // backup expiry: 1 hour

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
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        clientMessageId: req.body.clientMessageId || null,
        sentAt: Date.now(),
      };

      io.to(socketRoom(user.roomId)).emit("message:new", message);

      return res.json({
        success: true,
        message: "Image sent",
        data: message,
      });
    } catch (error) {
      console.error("Image upload error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send image",
      });
    }
  }
);

app.get("/api/messages/image/:imageId", async (req, res) => {
  try {
    const { imageId } = req.params;

    const image = await redis.hGetAll(keys.chatImage(imageId));

    if (!image || !image.data) {
      return res.status(404).json({
        success: false,
        message: "Image not found or expired",
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
      message: "Failed to fetch image",
    });
  }
});

io.on("connection", async (socket) => {
  const userId = socket.data.userId;

  console.log("Socket connected:", socket.id, userId);

  const user = await redis.hGetAll(keys.user(userId));

  if (!user || !user.userId) {
    socket.emit("auth:error", {
      message: "User session not found. Please login again.",
    });

    socket.disconnect();
    return;
  }

  await markUserOnline(userId, socket.id);

  await redis.hSet(keys.user(userId), {
    socketId: socket.id,
    status: user.status === 'in_room' ? "in_room" : "waiting",
    updatedAt: String(Date.now()),
  });

  await emitOnlineUsersCount();

  if (user.status === "in_room" && user.roomId) {
    socket.join(socketRoom(user.roomId));

    socket.emit("room:rejoined", {
      roomId: user.roomId,
      message: "Reconnected to existing room",
    });
  } else {
    socket.join("waiting");

    await redis.sAdd(keys.waitingUsers, userId);

    socket.emit("waiting:joined", {
      userId,
      message: "You are in waiting room",
    });

    await tryAutoMatch(socket);
  }
  /**
   * Client should send this every few seconds or whenever GPS changes.
   */
  socket.on("location:update", async (payload, ack) => {

    try {
      const { latitude, longitude, accuracy } = payload || {};
      if (!isValidLatLng(latitude, longitude)) {
        const response = {
          success: false,
          message: "Valid latitude and longitude are required",
        };

        if (ack) ack(response);
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
          updatedAt: String(Date.now()),
        });

        await redis.sAdd(keys.waitingUsers, userId);
        socket.join("waiting");

        await tryAutoMatch(socket);
      }

      const response = {
        success: true,
        message: "Location updated",
      };

      if (ack) ack(response);
    } catch (error) {
      console.error("location:update error:", error);

      const response = {
        success: false,
        message: "Failed to update location",
      };

      if (ack) ack(response);
    }
  });

  socket.on("room:leave", async (_, ack) => {
    try {
      const user = await redis.hGetAll(keys.user(userId));

      if (user.status !== "in_room" || !user.roomId) {
        const response = {
          success: false,
          message: "User is not inside any room",
        };

        if (ack) ack(response);
        return;
      }

      await closePairRoom({
        roomId: user.roomId,
        reason: "USER_LEFT",
        details: {
          userId,
        },
      });

      const response = {
        success: true,
        message: "Chat ended and users moved back to waiting room",
      };

      if (ack) ack(response);
    } catch (error) {
      console.error("room:leave error:", error);

      if (ack) {
        ack({
          success: false,
          message: "Failed to leave room",
        });
      }
    }
  });

  socket.on("disconnect", async () => {
    try {
      console.log("Socket disconnected:", socket.id, userId);

      const user = await redis.hGetAll(keys.user(userId));

      if (user.status === "in_room" && user.roomId) {
        await closePairRoom({
          roomId: user.roomId,
          reason: "USER_DISCONNECTED",
          offlineUserId: userId,
          details: {
            userId,
          },
        });

        return;
      }

      await redis.sRem(keys.waitingUsers, userId);
      await redis.zRem(keys.usersGeo, userId);

      await redis.hSet(keys.user(userId), {
        status: "offline",
        socketId: "",
        roomId: "",
        updatedAt: String(Date.now()),
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
        const response = {
          success: false,
          message: "Message text is required",
        };

        if (ack) ack(response);
        return;
      }

      const user = await redis.hGetAll(keys.user(userId));
      // console.log("User status:", user);
      if (user.status !== "in_room" || !user.roomId) {
        const response = {
          success: false,
          message: "You are not connected to any chat room",
        };

        if (ack) ack(response);
        return;
      }

      const message = {
        roomId: user.roomId,
        from: userId,
        text: text.trim(),
        clientMessageId: clientMessageId || null,
        sentAt: Date.now(),
      };

      /**
       * Important:
       * We are NOT saving this message in Redis or DB.
       * It only goes to active sockets.
       */
      io.to(socketRoom(user.roomId)).emit("message:new", message);

      const response = {
        success: true,
        message: "Message sent",
      };

      if (ack) ack(response);
    } catch (error) {
      console.error("message:send error:", error);

      if (ack) {
        ack({
          success: false,
          message: "Failed to send message",
        });
      }
    }
  });

});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
