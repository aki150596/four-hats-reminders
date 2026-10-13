# Four Hats reminders

A small scheduled job that sends Four Hats reminders (and nudges from friends) as push notifications, so they arrive
even when the app is closed. It runs free on GitHub Actions every 5 minutes. Each run keeps
checking every 30 seconds, so most reminders land within a minute or two of their time.
When GitHub is busy, a run can start late.

## How it works

1. When you set a reminder in Four Hats, the app saves its exact moment to `reminders/` in Firestore.
2. This job looks for reminders whose time has passed and sends each one to all of that person's
   devices that have notifications turned on (`users/<uid>/devices`).
3. It then marks the task "reminded" and removes the entry, so nothing is sent twice.

The repository is public so that GitHub Actions minutes are free and unlimited. It contains no
secrets. The Firebase key lives only in the repo's **Actions secrets**, and the job never logs task titles.

## Setup

- **Secret `FIREBASE_SERVICE_ACCOUNT`:** the whole contents of the JSON key file from
  Firebase console → Project settings → Service accounts → **Generate new private key**.
  Add it under GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
  Don't commit the key file.
- **To test:** go to the **Actions** tab → **Send reminders** → **Run workflow**.
