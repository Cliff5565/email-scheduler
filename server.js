import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import sgMail from "@sendgrid/mail";
import { fileURLToPath } from "url";
import IORedis from "ioredis";
import { zonedTimeToUtc, utcToZonedTime, format } from "date-fns-tz";
import fs from "fs";
import { EmailJob } from "./models/EmailJob.js";
import admin from "firebase-admin";
import multer from "multer";
import twilio from "twilio";

// Import crypto for decryption
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
  "TWILIO_WHATSAPP_NUMBER"
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

// ✅ Initialize Twilio Client
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
              body: body,
              from: process.env.TWILIO_PHONE_NUMBER || "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
              to: to,
            });
            console.log(`✅ SMS sent (job): ${message.sid} to ${to}`);
          } else {
            console.log(`📱 Mock SMS sent to ${to}: ${body}`);
          }
        } else if (method === "whatsapp") {
          if (twilioClient) {
            const message = await twilioClient.messages.create({
              body: body,
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
      } catch (err) {
        console.error("❌ Notification failed:", err.message);
        if (emailJobId) {
          await EmailJob.findByIdAndUpdate(emailJobId, {
            status: "failed",
            error: err.message,
          });
        }
        throw err; // let BullMQ retry
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
  try {
    const data = Buffer.from(encryptedText, 'base64');
    const iv = data.slice(0, 16); // 16 bytes for AES-GCM IV
    const encryptedData = data.slice(16);
    
    const decipher = createDecipheriv('aes-128-gcm', key.slice(0, 16), iv);
    decipher.setAuthTag(data.slice(-16));
    
    let decrypted = decipher.update(encryptedData, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err.message);
    throw err;
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
        return res.status(400).json({ error: "❌ Missing fields" });
      }
      if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
        return res.status(400).json({ error: "❌ Invalid timezone" });
      }

      // Get provider key
      const providerKey = process.env.PROVIDER_KEY;

      // Decrypt sensitive data
      const decryptedTo = decrypt(to, providerKey);
      const decryptedBody = decrypt(body, providerKey);
      const decryptedSubject = subject ? decrypt(subject, providerKey) : undefined;

      // Validate phone numbers for SMS and WhatsApp
      if (method === "sms" || method === "whatsapp") {
        const phoneRegex = /^\+[1-9]\d{1,14}$/; // E.164 format
        if (!phoneRegex.test(decryptedTo)) {
          return res.status(400).json({
            error: "❌ Invalid phone number. Use E.164 format: +1234567890",
          });
        }
      }

      // Validate WhatsApp number format
      if (method === "whatsapp") {
        // Ensure the number starts with country code
        if (!/^\+/.test(decryptedTo)) {
          return res.status(400).json({
            error: "❌ WhatsApp number must start with country code (e.g., +1234567890)",
          });
        }
      }

      let scheduledTime;
      try {
        scheduledTime = zonedTimeToUtc(datetime, timezone);
      } catch {
        return res.status(400).json({ error: "❌ Invalid datetime" });
      }

      const delayMs = scheduledTime.getTime() - Date.now();
      if (delayMs < 0) {
        return res.status(400).json({ error: "❌ Date is in the past" });
      }

      const attachment =
        req.file && method === "email"
          ? { filename: req.file.originalname, path: req.file.path }
          : undefined;

      const emailJob = await EmailJob.create({
        to: decryptedTo, // Store decrypted value in DB
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
        // fallback immediate send
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
          console.log("✅ Immediate email sent via SendGrid to", decryptedTo);
        } else if (method === "sms") {
          if (twilioClient) {
            const message = await twilioClient.messages.create({
              body: decryptedBody,
              from: process.env.TWILIO_PHONE_NUMBER || "MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
              to: decryptedTo,
            });
            console.log(
              `✅ SMS sent immediately: ${message.sid} to ${decryptedTo}`
            );
          } else {
            console.log(`📱 Mock SMS sent immediately to ${decryptedTo}: ${decryptedBody}`);
          }
        } else if (method === "whatsapp") {
          if (twilioClient) {
            const message = await twilioClient.messages.create({
              body: decryptedBody,
              from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
              to: `whatsapp:${decryptedTo}`,
            });
            console.log(
              `✅ WhatsApp sent immediately: ${message.sid} to ${decryptedTo}`
            );
          } else {
            console.log(`💬 Mock WhatsApp sent immediately to ${decryptedTo}: ${decryptedBody}`);
          }
        }
      }

      const localTime = utcToZonedTime(scheduledTime, timezone);
      return res.json({
        message: `✅ ${method.toUpperCase()} scheduled for ${format(
          localTime,
          "yyyy-MM-dd HH:mm:ss zzz",
          { timeZone: timezone }
        )}`,
        jobId: emailJob._id.toString(),
      });
    } catch (err) {
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

// ---------- API: Cancel Job ----------
app.delete("/api/jobs/:id", authenticateFirebase, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find the job
    const job = await EmailJob.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    
    // Check if user owns the job
    if (job.userId !== req.user.uid) {
      return res.status(403).json({ error: "Not authorized to cancel this job" });
    }
    
    // Cancel the job in the queue if it exists
    if (emailQueue) {
      await emailQueue.remove(id);
    }
    
    // Update job status
    await EmailJob.findByIdAndUpdate(id, { status: "cancelled" });
    
    res.json({ message: "Job cancelled successfully" });
  } catch (err) {
    console.error("❌ Cancel job error:", err.message);
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

// ---------- API: Update Job ----------
app.put("/api/jobs/:id", authenticateFirebase, async (req, res) => {
  try {
    const { id } = req.params;
    const { datetime, timezone, subject, body } = req.body;
    
    // Find the job
    const job = await EmailJob.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    
    // Check if user owns the job
    if (job.userId !== req.user.uid) {
      return res.status(403).json({ error: "Not authorized to update this job" });
    }
    
    // Check if job is already sent
    if (job.status !== "scheduled") {
      return res.status(400).json({ error: "Cannot update a job that is already sent or cancelled" });
    }
    
    // Validate timezone
    if (timezone && !Intl.supportedValuesOf("timeZone").includes(timezone)) {
      return res.status(400).json({ error: "❌ Invalid timezone" });
    }
    
    // Validate datetime
    let newScheduledTime;
    if (datetime) {
      try {
        newScheduledTime = zonedTimeToUtc(datetime, timezone || job.timezone);
      } catch {
        return res.status(400).json({ error: "❌ Invalid datetime" });
      }
      
      const delayMs = newScheduledTime.getTime() - Date.now();
      if (delayMs < 0) {
        return res.status(400).json({ error: "❌ Date is in the past" });
      }
    }
    
    // Update job in the queue if it exists
    if (emailQueue) {
      await emailQueue.remove(id);
      
      // Add updated job to queue
      await emailQueue.add(
        "sendNotification",
        {
          method: job.method,
          to: job.to, // Already decrypted
          subject: job.method === "email" ? (subject || job.subject) : undefined,
          body: body || job.body,
          emailJobId: id,
        },
        {
          id: id,
          delay: newScheduledTime ? (newScheduledTime.getTime() - Date.now()) : (job.datetime.getTime() - Date.now()),
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        }
      );
    }
    
    // Update job in database
    const updatedJob = await EmailJob.findByIdAndUpdate(
      id,
      {
        datetime: newScheduledTime || job.datetime,
        originalLocalTime: datetime || job.originalLocalTime,
        timezone: timezone || job.timezone,
        subject: job.method === "email" ? (subject || job.subject) : undefined,
        body: body || job.body,
      },
      { new: true }
    );
    
    res.json({ message: "Job updated successfully", job: updatedJob });
  } catch (err) {
    console.error("❌ Update job error:", err.message);
    res.status(500).json({ error: "Failed to update job" });
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
