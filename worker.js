// worker.js
import { Worker } from "bullmq";
import { transporter } from "./server.js"; // Import the same transporter
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

// Connect to Redis
const redisClient = new IORedis(process.env.REDIS_URL, {
  tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
});

// Create worker for the "emails" queue
const worker = new Worker(
  "emails",
  async (job) => {
    const { to, subject, body } = job.data;

    console.log(`📧 [Worker] Processing job ${job.id}: Sending to ${to}`);

    try {
      const info = await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body,
      });

      console.log(`✅ [Worker] Email sent to ${to} | Message ID: ${info.messageId}`);
      return { messageId: info.messageId }; // Optional: return success data
    } catch (err) {
      console.error(`❌ [Worker] Failed to send email to ${to}:`, err.message);
      throw err; // Let BullMQ handle retry/failure logic
    }
  },
  {
    connection: redisClient,
    concurrency: 5, // Process up to 5 emails at once
    removeOnComplete: true, // Remove completed jobs after processing
    removeOnFail: false, // Keep failed jobs for debugging
  }
);

// Event listeners
worker.on("completed", (job, result) => {
  console.log(`🎉 Job ${job.id} completed successfully:`, result);
});

worker.on("failed", (job, err) => {
  console.error(`💥 Job ${job.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("🔴 Worker error:", err);
});

worker.on("drained", () => {
  console.log("📦 All jobs processed — worker idle");
});

console.log("🚀 BullMQ Worker started and listening to 'emails' queue...");

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down worker...");
  await worker.close();
  process.exit(0);
});
