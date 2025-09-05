// server.js
import express from "express";
import mongoose from "mongoose";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import passport from "passport";
import scheduleRoutes from "./routes/schedule.js";
import authRoutes from "./routes/auth.js";

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
import "./auth/passportSetup.js";
app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use("/auth", authRoutes);
app.use("/schedule", scheduleRoutes);

app.listen(10000, () => console.log("🚀 Server running on port 10000"));
