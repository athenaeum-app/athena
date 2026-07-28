# Athena

A self-hosted application for journaling and archiving. Athena keeps your
notes, tasks, and ideas in a single library that you run and control. One Go
server hosts the library and serves a web client on the same origin, and a
desktop app can manage several servers at once. Data stays on your server:
there is no external account and no third-party service.

![The Athena feed](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/feed.png)

## Features

- **Moments.** Notes with a title, a Markdown body, colored tags, and file
  attachments (images, PDFs, audio, and video preview inline). Full-text
  search, filtering by date and media, pinning, and links between moments.
- **Tasks.** A board of lists with due dates, priorities, subtasks, recurring
  items, and an optional link to a related moment. An agenda view collects
  everything due across every list onto one timeline.
- **Canvas.** An infinite pan-and-zoom board with sticky notes, text labels,
  shapes, images, web links, moment references, and live todo embeds.
- **Chat.** A library-wide message log with the same formatting and embeds
  as moments.
- **Appearance.** Eleven color themes, six "Look" presets, and a custom
  theme editor.
- **Clients.** A browser PWA that installs to mobile, and a desktop app
  that can manage several servers at once.

More screenshots and demos: [athenaeum-app](https://github.com/athenaeum-app).

## Self-hosting

Athena ships as a single container. The image contains the Go server with
the web client compiled into it, so there is nothing else to run.

```bash
curl -O https://raw.githubusercontent.com/athenaeum-app/athena/master/docker-compose.yml
docker compose up -d
```

Open `http://<host>:8080`. The first account you register becomes the owner
and names the library; everyone else joins by invitation from the admin
panel.

Updating is two commands, and your data is untouched:

```bash
docker compose pull && docker compose up -d
```

## Desktop app

Installers for Windows, macOS, and Linux are on the
[Releases](https://github.com/athenaeum-app/athena/releases) page. The app
updates itself.

## About this repository

Athena is a personal project and its source isn't public. This repository
holds the desktop installers and the compose file for self-hosting the
container. Found a bug? Open an issue here.
