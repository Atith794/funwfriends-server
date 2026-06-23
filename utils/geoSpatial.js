export function isValidLatLng(latitude, longitude) {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function parseGeoSearchResult(result) {
  return result.map((item) => {
    return {
      userId: item[0],
      distanceKm: Number(item[1]),
    };
  });
}





/**
 * API 3:
 * Mark user as unavailable.
 */
// app.post("/users/unavailable", async (req, res) => {
//   try {
//     const { userId } = req.body;

//     if (!userId) {
//       return res.status(400).json({ message: "userId is required" });
//     }

//     await redis.zRem(GEO_KEY, userId);

//     await redis.hSet(userKey(userId), {
//       status: "unavailable",
//       updatedAt: String(Date.now()),
//     });

//     return res.json({
//       message: "User marked as unavailable",
//       userId,
//     });
//   } catch (error) {
//     console.error("Unavailable user error:", error);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// });

/**
 * API 4:
 * End match and make users available again.
 */
// app.post("/match/end", async (req, res) => {
//   try {
//     const { userId } = req.body;

//     if (!userId) {
//       return res.status(400).json({ message: "userId is required" });
//     }

//     const userData = await redis.hGetAll(userKey(userId));

//     if (!userData || !userData.userId) {
//       return res.status(404).json({ message: "User not found" });
//     }

//     const matchedWith = userData.matchedWith;

//     await redis.hSet(userKey(userId), {
//       status: "available",
//       roomId: "",
//       matchedWith: "",
//       updatedAt: String(Date.now()),
//     });

//     if (matchedWith) {
//       await redis.hSet(userKey(matchedWith), {
//         status: "available",
//         roomId: "",
//         matchedWith: "",
//         updatedAt: String(Date.now()),
//       });
//     }

//     /**
//      * Add users back to GEO only if their coordinates exist.
//      */
//     if (userData.longitude && userData.latitude) {
//       await redis.sendCommand([
//         "GEOADD",
//         GEO_KEY,
//         userData.longitude,
//         userData.latitude,
//         userId,
//       ]);
//     }

//     const matchedUserData = matchedWith
//       ? await redis.hGetAll(userKey(matchedWith))
//       : null;

//     if (
//       matchedWith &&
//       matchedUserData &&
//       matchedUserData.longitude &&
//       matchedUserData.latitude
//     ) {
//       await redis.sendCommand([
//         "GEOADD",
//         GEO_KEY,
//         matchedUserData.longitude,
//         matchedUserData.latitude,
//         matchedWith,
//       ]);
//     }

//     return res.json({
//       message: "Match ended successfully",
//       userId,
//       matchedWith,
//     });
//   } catch (error) {
//     console.error("End match error:", error);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// });