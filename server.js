import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import sgMail from "@sendgrid/mail";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
// Updated imports for date-fns-tz v3+
import { fromZonedTime, toZonedTime, format } from "date-fns-tz";
import fs from "fs";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";
import multer from "multer";
import twilio from "twilio";
import { createDecipheriv } from "crypto";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Validate env vars ----------
const requiredEnv = [
  "MONGO_URI",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "PROVIDER_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_NUMBER",
];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// ---------- Firebase Admin ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
console.log("✅ Firebase Admin ready");

// ---------- Mongo ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis + BullMQ ----------
let emailQueue = null;
let redisClient = null;

// ---------- Twilio Client ----------
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("✅ Twilio ready (SMS/WhatsApp)");
} else {
  console.warn("⚠️ TWILIO_* env vars not set — SMS/WhatsApp will be mocked");
}

// ---------- SendGrid ----------
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Helper for safe file removal
async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
    console.log(`🗑️ Deleted temporary file: ${filePath}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`⚠️ Failed to delete file ${filePath}:`, err.message);
    }
  }
}

if (process.env.REDIS_URL) {
  redisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  redisClient.on("error", (err) =>
    console.error("❌ Redis error:", err.message)
  );
  redisClient.on("ready", () => console.log("✅ Redis connected"));

  emailQueue = new Queue("notifications", { connection: redisClient });
  console.log("✅ Queue initialized");

  // ---------- Worker ----------
  new Worker(
    "notifications",
    async (job) => {
      console.log("📧/📱💬 Processing job:", job.id, job.data);
      const { method, to, subject, body, emailJobId, attachment } = job.data;

      try {
        if (method === "email") {
          const msg = {
            to,
            from: process.env.SENDGRID_FROM_EMAIL,
            subject,
            text: body,
            attachments: attachment
              ? [
                  {
                    content: Buffer.from(
                      await fs.promises.readFile(attachment.path)
                    ).toString("base64"),
                    filename: attachment.filename,
                    type: "application/octet-stream",
                    disposition: "attachment",
                  },
                ]
              : [],
          };
          await sgMail.send(msg);
          console.log("✅ Email sent (job) via SendGrid:", to);
        } else if (method === "sms") {
          if (twilioClient) {
            const message = await twilioClient.messages.create({
              body,
              from: process.env.TWILIO_PHONE_NUMBER || "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
              to,
            });
            console.log(`✅ SMS sent (job): ${message.sid} to ${to}`);
          } else {
            console.log(`📱 Mock SMS sent to ${to}: ${body}`);
          }
        } else if (method === "whatsapp") {
          if (twilioClient) {
            const message = await twilioClient.messages.create({
              body,
              from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
              to: `whatsapp:${to}`,
            });
            console.log(`✅ WhatsApp sent (job): ${message.sid} to ${to}`);
          } else {
            console.log(`💬 Mock WhatsApp sent to ${to}: ${body}`);
          }
        }

        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "sent",
            sentAt: new Date(),
          });
        }

        // Cleanup attachment on success
        if (attachment?.path) {
          await safeUnlink(attachment.path);
        }
      } catch (err) {
        console.error("❌ Notification failed:", err.message);
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "failed",
            error: err.message,
          });
        }
        throw err; // Allow BullMQ retry
      }
    },
    { connection: redisClient }
  );
} else {
  console.warn("⚠️ REDIS_URL not set — notifications will send immediately");
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- File Upload ----------
const upload = multer({ dest: path.join(__dirname, "uploads/") });

// ---------- Auth middleware ----------
async function authenticateFirebase(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "❌ Unauthorized: No token" });
  }
  try {
    const idToken = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Invalid token:", err.message);
    return res.status(401).json({ error: "❌ Invalid/expired token" });
  }
}

// ---------- Decryption function ----------
function decrypt(encryptedText, key) {
  const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(encryptedText);

  if (!isBase64) {
    return encryptedText;
  }

  try {
    const data = Buffer.from(encryptedText, "base64");
    const iv = data.slice(0, 16);
    const encryptedData = data.slice(16, -16);
    const authTag = data.slice(-16);

    const decipher = createDecipheriv("aes-128-gcm", key.slice(0, 16), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, null, "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    return encryptedText;
  }
}

// ---------- API: Schedule Notification ----------
app.post(
  "/api/schedule",
  authenticateFirebase,
  upload.single("file"),
  async (req, res) => {
    try {
      const data = req.body.data ? JSON.parse(req.body.data) : req.body;
      const { to, subject, body, datetime, timezone, method = "email" } = data;

      if (!to || !body || !datetime || !timezone) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "❌ Missing fields" });
      }
      if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "❌ Invalid timezone" });
      }

      const providerKey = process.env.PROVIDER_KEY;
      const decryptedTo = decrypt(to, providerKey);
      const decryptedBody = decrypt(body, providerKey);
      const decryptedSubject = subject ? decrypt(subject, providerKey) : undefined;

      // Validate phone numbers
      if (method === "sms" || method === "whatsapp") {
        const phoneRegex = /^\+[1-9]\d{1,14}$/;
        if (!phoneRegex.test(decryptedTo)) {
          if (req.file) await safeUnlink(req.file.path);
          return res.status(400).json({
            error: "❌ Invalid phone number. Use E.164 format: +1234567890",
          });
        }
      }

      let scheduledTime;
      try {
        // Updated to use fromZonedTime (date-fns-tz v3+)
        scheduledTime = fromZonedTime(datetime, timezone);
      } catch {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "❌ Invalid datetime" });
      }

      const delayMs = scheduledTime.getTime() - Date.now();
      if (delayMs < 0) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "❌ Date is in the past" });
      }

      // Cleanup files attached to non-email notifications
      if (method !== "email" && req.file) {
        await safeUnlink(req.file.path);
      }

      const attachment = req.file && method === "email"
        ? { filename: req.file.originalname, path: req.file.path }
        : undefined;

      const emailJob = await EmailJob.create({
        to: decryptedTo,
        subject: method === "email" ? decryptedSubject : undefined,
        body: decryptedBody,
        datetime: scheduledTime,
        originalLocalTime: datetime,
        timezone,
        status: "scheduled",
        userId: req.user.uid,
        method,
        attachment,
      });

      if (emailQueue) {
        await emailQueue.add(
          "sendNotification",
          {
            method,
            to: decryptedTo,
            subject: decryptedSubject,
            body: decryptedBody,
            emailJobId: emailJob._id.toString(),
            attachment,
          },
          {
            id: emailJob._id.toString(),
            delay: delayMs,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
          }
        );
      } else {
        // Fallback immediate send
        try {
          if (method === "email") {
            const msg = {
              to: decryptedTo,
              from: process.env.SENDGRID_FROM_EMAIL,
              subject: decryptedSubject,
              text: decryptedBody,
              attachments: attachment
                ? [
                    {
                      content: Buffer.from(
                        await fs.promises.readFile(attachment.path)
                      ).toString("base64"),
                      filename: attachment.filename,
                      type: "application/octet-stream",
                      disposition: "attachment",
                    },
                  ]
                : [],
            };
            await sgMail.send(msg);
          } else if (method === "sms" && twilioClient) {
            await twilioClient.messages.create({
              body: decryptedBody,
              from: process.env.TWILIO_PHONE_NUMBER || "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
              to: decryptedTo,
            });
          } else if (method === "whatsapp" && twilioClient) {
            await twilioClient.messages.create({
              body: decryptedBody,
              from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
              to: `whatsapp:${decryptedTo}`,
            });
          }
        } finally {
          if (attachment?.path) await safeUnlink(attachment.path);
        }
      }

      // Updated to use toZonedTime (date-fns-tz v3+)
      const localTime = toZonedTime(scheduledTime, timezone);
      return res.json({
        message: `✅ ${method.toUpperCase()} scheduled for ${format(
          localTime,
          "yyyy-MM-dd HH:mm:ss zzz",
          { timeZone: timezone }
        )}`,
        jobId: emailJob._id.toString(),
      });
    } catch (err) {
      if (req.file) await safeUnlink(req.file.path);
      console.error("❌ Schedule error:", err.message);
      return res.status(500).json({ error: "❌ Server error: " + err.message });
    }
  }
);

// ---------- API: Get Jobs ----------
app.get("/api/jobs", authenticateFirebase, async (req, res) => {
  try {
    const jobs = await EmailJob.find({ userId: req.user.uid }).sort({
      datetime: 1,
    });

    const counts = {
      email: jobs.filter(
        (j) => j.method === "email" && j.status === "scheduled"
      ).length,
      sms: jobs.filter(
        (j) => j.method === "sms" && j.status === "scheduled"
      ).length,
      whatsapp: jobs.filter(
        (j) => j.method === "whatsapp" && j.status === "scheduled"
      ).length,
    };

    res.json({ jobs, counts });
  } catch (err) {
    console.error("❌ Fetch jobs error:", err.message);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// ---------- API: Update Job ----------
app.put(
  "/api/jobs/:id",
  authenticateFirebase,
  upload.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;

      let data;
      if (req.file || req.body.data) {
        data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body;
      } else {
        data = req.body;
      }

      const { datetime, timezone } = data;

      const job = await EmailJob.findById(id);
      if (!job) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.userId !== req.user.uid) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(403).json({ error: "Not authorized to update this job" });
      }

      if (job.status !== "scheduled") {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "Cannot update a job that is already sent or cancelled" });
      }

      if (timezone && !Intl.supportedValuesOf("timeZone").includes(timezone)) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(400).json({ error: "❌ Invalid timezone" });
      }

      let newScheduledTime;
      if (datetime) {
        try {
          // Updated to use fromZonedTime
          newScheduledTime = fromZonedTime(datetime, timezone || job.timezone);
        } catch {
          if (req.file) await safeUnlink(req.file.path);
          return res.status(400).json({ error: "❌ Invalid datetime" });
        }

        const delayMs = newScheduledTime.getTime() - Date.now();
        if (delayMs < 0) {
          if (req.file) await safeUnlink(req.file.path);
          return res.status(400).json({ error: "❌ Date is in the past" });
        }
      }

      const providerKey = process.env.PROVIDER_KEY;

      let updatedAttachment = job.attachment;
      if (req.file && job.method === "email") {
        if (job.attachment?.path) {
          await safeUnlink(job.attachment.path);
        }
        updatedAttachment = { filename: req.file.originalname, path: req.file.path };
      } else if (req.file) {
        await safeUnlink(req.file.path);
      }

      let decryptedTo = job.to;
      let decryptedSubject = job.subject;
      let decryptedBody = job.body;

      if (data.to) decryptedTo = decrypt(data.to, providerKey);
      if (data.subject) decryptedSubject = decrypt(data.subject, providerKey);
      if (data.body) decryptedBody = decrypt(data.body, providerKey);

      if (emailQueue) {
        await emailQueue.remove(id);

        await emailQueue.add(
          "sendNotification",
          {
            method: job.method,
            to: decryptedTo,
            subject: job.method === "email" ? decryptedSubject : undefined,
            body: decryptedBody,
            emailJobId: id,
            attachment: updatedAttachment,
          },
          {
            id: id,
            delay: newScheduledTime ? newScheduledTime.getTime() - Date.now() : job.datetime.getTime() - Date.now(),
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
          }
        );
      }

      const updatedJob = await EmailJob.findByIdAndUpdate(
        id,
        {
          datetime: newScheduledTime || job.datetime,
          originalLocalTime: datetime || job.originalLocalTime,
          timezone: timezone || job.timezone,
          subject: job.method === "email" ? decryptedSubject : undefined,
          body: decryptedBody,
          attachment: updatedAttachment,
        },
        { new: true }
      );

      res.json({ message: "Job updated successfully", job: updatedJob });
    } catch (err) {
      console.error("❌ Update job error:", err.message);
      if (req.file) await safeUnlink(req.file.path);
      res.status(500).json({ error: "Failed to update job" });
    }
  }
);

// ---------- API: Cancel Job ----------
app.delete("/api/jobs/:id", authenticateFirebase, async (req, res) => {
  try {
    const { id } = req.params;

    const job = await EmailJob.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.userId !== req.user.uid) {
      return res.status(403).json({ error: "Not authorized to cancel this job" });
    }

    if (emailQueue) {
      await emailQueue.remove(id);
    }

    if (job.attachment?.path) {
      await safeUnlink(job.attachment.path);
    }

    await EmailJob.findByIdAndUpdate(id, { status: "cancelled" });

    res.json({ message: "Job cancelled successfully" });
  } catch (err) {
    console.error("❌ Cancel job error:", err.message);
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

// ---------- API: Logout ----------
app.post("/api/logout", authenticateFirebase, async (req, res) => {
  try {
    await admin.auth().revokeRefreshTokens(req.user.uid);
    console.log(`👤 User ${req.user.uid} logged out and tokens revoked`);
    res.json({ message: "✅ Logged out (tokens revoked)" });
  } catch (err) {
    console.error("❌ Logout error:", err.message);
    res.status(500).json({ error: "❌ Failed to logout" });
  }
});

// ---------- Static pages ----------
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/register", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "register.html"))
);
app.get("/schedule", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "schedule.html"))
);
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------- Global Error Handler ----------
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  if (req.path.startsWith("/api")) {
    res.status(500).json({ error: "❌ Unexpected server error" });
  } else {
    res.status(500).send("Internal Server Error");
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
