// src/server.js
import express from "express";
import mongoose from "mongoose";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import passport from "passport";
import dotenv from "dotenv";

// Load env variables
dotenv.config();

// Routes
import scheduleRoutes from "./routes/schedule.js";
import authRoutes from "./routes/auth.js";

// 🔹 Start app
const app = express();
app.use(express.json());

// 🔹 Redis setup
const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();
const redisStore = new RedisStore({ client: redisClient });

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

// 🔹 MongoDB
await mongoose.connect(process.env.MONGO_URI);

// 🔹 Passport strategies
import "./auth/passportSetup.js"; // your strategies live here
app.use(passport.initialize());
app.use(passport.session());

// 🔹 Routes
app.use("/auth", authRoutes);       // e.g. Google OAuth
app.use("/schedule", scheduleRoutes); // your schedule routes

// 🔹 Default route
app.get("/", (req, res) => {
  res.send("✅ Server is running");
});

// 🔹 Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
