// models/EmailJob.js
import mongoose from "mongoose";

const emailJobSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  datetime: { type: Date, required: true },
  originalLocalTime: { type: String, required: true },
  timezone: { type: String, required: true },
  status: {
    type: String,
    enum: ["scheduled", "sent", "failed"],
    default: "scheduled",
  },
  sentAt: Date,
  error: String,
  userId: { type: String }, // Firebase UID
}, { timestamps: true });

export const EmailJob = mongoose.model("EmailJob", emailJobSchema);
