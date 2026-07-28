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

## Demos

| Themes and looks |
| --- |
| ![Cycling through themes and looks](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/themes.gif) |
| The same feed under seven theme and look pairings. A theme sets the palette, a look sets surfaces, typography and shape, and the two compose freely. |

| To-do board |
| --- |
| ![Checking off tasks and switching to the agenda](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/todos.gif) |
| Checking items off a task list, then switching to the agenda, which collects what is still due across every list. Ocean theme, Slate-soft look. |

## Screenshots

Each screenshot below uses a different theme and look, named in its caption.
Nothing else differs between them: it is the same library, the same content,
and the same build throughout.

| To-do board | Agenda |
| :---: | :---: |
| ![To-do board](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/todos.png)<br><sub>Ocean theme, Slate-soft look</sub> | ![Agenda view](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/agenda.png)<br><sub>Royal Blue theme, Ink look</sub> |

| Canvas | Chat |
| :---: | :---: |
| ![Canvas](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/canvas.png)<br><sub>Sunset theme, Aurora look</sub> | ![Chat](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/chat.png)<br><sub>Arctic theme, Slate-soft look</sub> |

| Focused reader | Appearance settings |
| :---: | :---: |
| ![Focused moment reader](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/focused-moment.png)<br><sub>Neutral theme, Editorial look</sub> | ![Appearance settings](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/settings.png)<br><sub>Rosewood theme, Legacy look</sub> |

| Mobile feed | Mobile filter | Mobile chat |
| :---: | :---: | :---: |
| ![Mobile feed](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/mobile-feed.png)<br><sub>Valentine theme, Editorial look</sub> | ![Mobile filter sheet](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/mobile-filter.png)<br><sub>Dark theme, Glass look</sub> | ![Mobile chat](https://raw.githubusercontent.com/athenaeum-app/.github/master/assets/mobile-chat.png)<br><sub>Light theme, Ink look</sub> |

More on themes and looks: [athenaeum-app](https://github.com/athenaeum-app).

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

This repository holds the desktop installers and the compose file for
self-hosting the container. Found a bug? Open an issue here.
