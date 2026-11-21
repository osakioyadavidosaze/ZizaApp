# Ziza App

Ziza is a private-number messenger built with Next.js, TypeScript, and Supabase. This workspace includes the frontend, username-only Auth adapter, and Supabase migrations.

## Step 1: Supabase database

Apply [`supabase/migrations/20261119000000_ziza_core.sql`](./supabase/migrations/20261119000000_ziza_core.sql) to a Supabase project:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

The migrations provide:

- A permanent, randomly generated, unique 10-digit Ziza Number on Auth signup. The database stores digits only; format it as `XXX-XXX-XXXX` for display.
- Exact-number-only discovery through `lookup_ziza_number` and contact requests through `send_contact_request`; neither exposes a user directory. Contact approval and direct-conversation creation are server-validated RPCs.
- RLS-protected profiles, contacts, conversations, members, messages, reactions, receipts, streaks, stories, and private media buckets.
- Message reply references, edits/deletes-for-everyone fields, media metadata, sender-selected message expiry, story expiry after 24 hours, and read-receipt preferences.
- Direct-chat streaks that complete when both participants send a message within a rolling 24-hour window. The UI shows an expiry warning during the final four hours and hides expired counts.
- Rolling streak timestamps, block relationships enforced by server policies and RPCs, and an independent per-member unread cursor.

For signup, set Auth user metadata with `username` (3–24 letters, numbers, or underscores) and optionally `display_name`. The database trigger creates the profile and Ziza Number in the same Auth transaction.

Online presence and typing should use authenticated Supabase Realtime Presence/Broadcast, not persisted profile flags. The UI must honor `hide_online_status`; ephemeral presence is not a substitute for authorization. `read_receipts_enabled` prevents `mark_message_read` from recording a receipt. A sender's disappearing-message preference is applied to their newly sent messages.

## Run the app

Install dependencies, copy `.env.local.example` to `.env.local`, and set the Supabase project URL and anon key:

```powershell
npm install
npm run dev
```

Required public environment variables:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

`SUPABASE_SERVICE_ROLE_KEY` is optional and is only used server-side to resolve a Ziza Number to a username during login. Never expose it to browser code. Username login works without it.

Supabase Auth does not provide a native username/password provider. This app uses a server-generated, non-deliverable internal alias; configure Auth to disable email confirmation for signup. Do not ask users for a real email or phone. Username-only account recovery is not implemented yet, so configure and test a separate recovery process before production.

## Implemented routes

- **`/`** — Signup/login and post-signup Ziza Number/QR reveal.
- **`/chat`** — Responsive conversation list and chat, contact requests, exact-number lookup/QR scanning, realtime messages/presence/typing, reactions, replies, edits, deletes, attachments, and voice notes.
- **`/stories`** — Create text/photo stories and view active stories from accepted contacts.
- **`/settings`** — Online visibility, read receipts, default disappearing timer, device-local theme, and blocked accounts.

Media is uploaded to private Storage buckets and accessed using short-lived signed URLs. The UI can hide expired messages, stories, and streaks, but scheduled physical cleanup still needs to be configured.

## PWA and Android app

The App Router manifest at `/manifest.webmanifest` and the icons in `public/icons/` enable browser installation over HTTPS. The app uses standalone display mode and mobile safe-area insets; offline use is not configured.

The Capacitor Android project uses `https://zizaapp.vercel.app` as its WebView URL, so the native app requires a network connection and picks up deployed web updates without a new APK. Capacitor documents `server.url` as intended for live reload rather than production packaging. For a store release, review the [Capacitor production workflow](https://capacitorjs.com/docs/basics/workflow) and package the web assets instead of relying on the remote URL.

To sync the native project and open it in Android Studio (with the Android SDK installed):

```powershell
npm run build
npx cap sync android
npx cap open android
```

After changing the Capacitor config or adding native plugins, run `npx cap sync android` again.

## Product blueprint

### Routes and user flows

- **`/` — Landing and authentication:** signup and login tabs. Signup collects display name, username, and a strong password; do not offer a 4-digit PIN as the account password. After successful signup, load the server-created profile before showing a celebratory Ziza Number modal with copy and QR-download actions. Login accepts either username or Ziza Number.
- **`/chat` — Chat dashboard:** desktop split layout with a contacts/chat sidebar and conversation panel; on mobile, show one panel at a time with an explicit back-to-chat-list navigation action.
- **Sidebar:** profile/number/copy controls, stories entry, settings action, exact-number search, QR scanner entry, and chat rows showing the other person's name, last message, time, unread count, and active streak/warning state.
- **Conversation panel:** contact name and number, privacy-aware online/offline/typing status, streak state, disappearing-message preference and block actions, replies, edits, delete-for-everyone, emoji reactions, read ticks, attachments, and voice-note playback.
- **`/stories` — Stories:** create a short text or photo story, view active stories from accepted contacts, and show each story's remaining lifetime.
- **`/settings` — Privacy and account:** hide online status, disable read receipts, choose the default disappearing timer, choose dark/light theme, and manage blocked users. Session management and a device-local app lock are not implemented.

### Product rules and interaction details

- Store Ziza Numbers as exactly 10 digits and format only for display. QR codes should encode an app link containing the number, not a public profile URL. Scanning must feed the same exact-number lookup flow as manual entry.
- Exact-number lookup returns only the minimum profile preview needed to confirm a contact request. It must not support partial matches, directory browsing, or unauthenticated lookup. Add rate limits and generic error responses to reduce account enumeration.
- A contact request is not an accepted contact. Only accepted relationships can start direct chats or view stories. Add a block action that prevents new requests/messages and hides presence/stories in both directions; block state must be enforced server-side, not only hidden in the UI.
- Presence and typing are ephemeral Realtime signals. Do not infer online status from old timestamps when the user has hidden it. Read ticks are created only when the reader has enabled read receipts; message delivery and unread tracking must remain separate from read receipts.
- Use private Storage buckets and short-lived signed URLs. The voice recorder should handle browser permission denial and unsupported codecs; waveform rendering is a playback visualization, not a requirement to store waveform samples.
- Expired content should become unavailable immediately through queries and Storage authorization. A scheduled cleanup job should later remove expired rows and orphaned objects.
- Theme choice and app lock are device preferences. Do not treat either as account authentication or authorization.

### Remaining data-model and product decisions

The frontend and migrations cover the core flows, but these items still need decisions or production work:

1. **Number prefixes are not enforced.** The generator currently creates any unique 10-digit number. Decide whether numbers must start with `77`, `88`, or another prefix before launch; do not retrofit by changing existing permanent numbers.
2. **Account recovery is not implemented.** A 4-digit PIN is too weak for primary authentication. Keep strong passwords and design recovery that does not rely on email/SMS before production.
3. **Disappearing messages are sender-preference based.** A user's default timer applies to messages they send; confirm that this matches the intended conversation UX.
4. **Unread badges are based on the latest 300 fetched messages per conversation.** Add message pagination and compute complete unread totals if exact counts beyond that window are required.

These are intentional prerequisites, not frontend-only details: RLS, RPCs, and Realtime policies must enforce the same rules as the interface.

## Important production follow-ups

- Configure Auth password policy, signup rate limits, CAPTCHA/abuse controls, and recovery without requiring a phone number or email as an identity.
- Add database-backed rate limiting for exact-number lookup and contact requests before public launch; RLS prevents directory reads but does not itself prevent repeated guesses.
- Schedule cleanup of expired messages, stories, and orphaned Storage objects. Expiry timestamps and query policies hide expired content; they do not physically delete it.
- Restrict document uploads further if the supported file types need to be narrower. Keep uploads private and deliver them with short-lived signed URLs.
- Configure and validate Supabase Realtime authorization for the tables/channels used by the app. Do not broadcast private profile fields or message content to non-members.
