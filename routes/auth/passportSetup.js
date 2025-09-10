// src/auth/passportSetup.js
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import mongoose from "mongoose";

// Example: User model (adjust path to your model if you already have one)
import User from "../models/User.js";

// 🔹 Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,        // from Render env vars
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",          // must match in Google Console
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // 1. Check if user already exists
        let user = await User.findOne({ googleId: profile.id });

        // 2. If not, create a new user
        if (!user) {
          user = await User.create({
            googleId: profile.id,
            displayName: profile.displayName,
            email: profile.emails?.[0]?.value,
          });
        }

        // 3. Pass user to Passport
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// 🔹 Serialize user into session
passport.serializeUser((user, done) => {
  done(null, user.id); // stores user ID in session
});

// 🔹 Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

export default passport;
