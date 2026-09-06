# 🗺️ Product Roadmap — YUTorah Enhanced Player

This document outlines planned milestones and feature specifications for the YUTorah Enhanced Player.

---

## 🎯 Next Major Milestone: User Accounts & Listening History

> **Goal:** Provide a lightweight, zero-friction account system with long-lived persistent sessions and synchronized listening history across devices.

### 1. Persistent Authentication
- **User Login & Registration Option:** An accessible login/registration modal on the site.
- **Long-Lived Auto-Login:** Once logged in, the user stays logged in automatically for as long as possible via secure, long-lived `HttpOnly` session cookies (or refresh tokens) with `SameSite=Lax` (e.g. 1-year duration or rolling expiration). Users will not need to repeatedly log back in.

### 2. Listening History & Progress Tracking
- **Automatic History Logging:** Every shiur played while logged in is automatically recorded to the user's account history.
- **Playback Progress ("Where you are up to"):** Tracks and saves the exact timestamp and progress within each shiur so that resuming on any device picks up where you left off.
- **Organized by Date:** A dedicated "Listening History" section neatly grouped and sorted chronologically by date (e.g., *Today*, *Yesterday*, *This Week*, or specific dates) showing which shiurim were listened to and the progress in each.
- **Focused Scope:** For now, the user account system will strictly store listening history, timestamp progress, and date organization only (no extraneous features like playlists, comments, or public profiles for now).

### 3. Edge Architecture Plan
- **Storage Layer:** Cloudflare D1 (serverless SQLite at the edge) or Cloudflare KV on the free tier.
- **Authentication:** Native Web Crypto API (`PBKDF2` / `HMAC` / `SHA-256`) within the Cloudflare Worker runtime.
- **Database Schema:**
  - `users`: `id`, `username`/`email`, `password_hash`, `created_at`
  - `sessions`: `token`, `user_id`, `expires_at`, `last_active_at`
  - `listening_history`: `user_id`, `shiur_id`, `progress_seconds`, `duration_seconds`, `last_listened_at`

---

## 📋 General Roadmap & Feature Backlog

- [x] Clickable metadata filter chips (Speaker, Venue, Categories, Keywords).
- [x] Persistent sticky bottom mini-player with uninterrupted playback across the site.
- [x] Collapsible speaker biographies and venue descriptions with Read More / Show Less.
- [x] Directional triangular -10 and +10 mini-player controls with touch spacing.
- [x] Dark Mode / Light Mode toggle with URL parameter (`?mode=dark`) and localStorage persistence.
- [x] Playback speed URL synchronization (`?speed=1.5`).
- [x] Live daily YUTorah sponsorship extraction and caching with GiveCampus donation link.
- [ ] **User Accounts with Persistent Login & Listening History by Date** *(Planned)*
- [ ] Multi-shiur playback queue ("Play Next" / Playlist mode).
- [ ] Offline caching via Service Worker (PWA installable app).
- [ ] Optional GitHub Pages static deployment fallback.
