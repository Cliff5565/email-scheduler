import mongoose from "mongoose";

const EmailJobSchema = new mongoose.Schema({
  to: String,
  subject: String,
  body: String,
  datetime: Date,
  originalLocalTime: String,
  timezone: String,
  status: { type: String, default: "scheduled" },
  sentAt: Date,
  error: String,
});

export const EmailJob = mongoose.model("EmailJob", EmailJobSchema);
