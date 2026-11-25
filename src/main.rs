use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, header},
    response::{Html, IntoResponse},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, watch},
    time,
};
use uuid::Uuid;

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Playback {
    position: f64,
    paused: bool,
}

#[derive(Clone, Copy)]
struct Timeline {
    playback: Playback,
    updated_at: Instant,
}

impl Timeline {
    fn new(playback: Playback) -> Self {
        Self {
            playback,
            updated_at: Instant::now(),
        }
    }

    fn snapshot(self) -> Playback {
        let elapsed = if self.playback.paused {
            0.0
        } else {
            self.updated_at.elapsed().as_secs_f64()
        };
        Playback {
            position: self.playback.position + elapsed,
            ..self.playback
        }
    }
}

#[derive(Clone, Copy)]
struct RoomState {
    timeline: Timeline,
    participants: u32,
    host_online: bool,
}

struct Room {
    media: String,
    host_key: Uuid,
    state: watch::Sender<RoomState>,
}

type Rooms = Arc<Mutex<HashMap<Uuid, Room>>>;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Create {
        media: String,
        playback: Playback,
    },
    Join {
        code: Uuid,
        media: String,
    },
    Resume {
        code: Uuid,
        key: Uuid,
        media: String,
        playback: Playback,
    },
    Playback {
        playback: Playback,
    },
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Reply {
    Joined {
        code: Uuid,
        key: Option<Uuid>,
    },
    State {
        playback: Playback,
        participants: u32,
        host_online: bool,
    },
    Error {
        message: &'static str,
    },
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let address = std::env::var("DALEPLAY_BIND").unwrap_or_else(|_| "127.0.0.1:3190".into());
    let listener = TcpListener::bind(address).await?;
    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("demo.html")) }))
        .route("/demo.wav", get(demo_audio))
        .route("/room", get(upgrade))
        .with_state(Rooms::default());
    println!("DalePlay · http://{}", listener.local_addr()?);
    axum::serve(listener, app).await
}

async fn upgrade(
    State(rooms): State<Rooms>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin.is_some_and(|value| !value.starts_with("chrome-extension://")) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| session(socket, rooms))
}

async fn send(socket: &mut WebSocket, reply: Reply) -> bool {
    let Ok(text) = serde_json::to_string(&reply) else {
        return false;
    };
    matches!(
        time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}

fn valid(playback: Playback) -> bool {
    playback.position.is_finite() && (0.0..=604_800.0).contains(&playback.position)
}

async fn admit(
    rooms: &Rooms,
    request: Request,
) -> Result<(Uuid, Option<Uuid>, watch::Receiver<RoomState>), &'static str> {
    let mut rooms = rooms.lock().await;
    match request {
        Request::Create { media, playback } if !media.is_empty() && valid(playback) => {
            if rooms.len() >= 500 {
                return Err("El servidor alcanzó su límite de salas.");
            }
            let code = Uuid::new_v4();
            let key = Uuid::new_v4();
            let (state, receiver) = watch::channel(RoomState {
                timeline: Timeline::new(playback),
                participants: 1,
                host_online: true,
            });
            rooms.insert(
                code,
                Room {
                    media,
                    host_key: key,
                    state,
                },
            );
            Ok((code, Some(key), receiver))
        }
        Request::Join { code, ref media }
        | Request::Resume {
            code, ref media, ..
        } => {
            let room = rooms.get(&code).ok_or("No se encontró la sala.")?;
            if &room.media != media {
                return Err("Abre el mismo video que el anfitrión.");
            }
            if room.state.borrow().participants >= 32 {
                return Err("La sala está llena.");
            }
            let key = match request {
                Request::Resume { key, playback, .. } => {
                    if room.host_key != key || !valid(playback) {
                        return Err("Invitación de anfitrión inválida.");
                    }
                    if room.state.borrow().host_online {
                        return Err("El anfitrión sigue conectado.");
                    }
                    room.state.send_modify(|state| {
                        state.timeline = Timeline::new(playback);
                        state.host_online = true;
                    });
                    Some(key)
                }
                _ => None,
            };
            room.state.send_modify(|state| state.participants += 1);
            Ok((code, key, room.state.subscribe()))
        }
        _ => Err("Solicitud de sala inválida."),
    }
}

async fn session(mut socket: WebSocket, rooms: Rooms) {
    let Ok(Some(Ok(Message::Text(first)))) =
        time::timeout(Duration::from_secs(10), socket.recv()).await
    else {
        return;
    };
    let Ok(request) = serde_json::from_str(&first) else {
        return;
    };
    let (code, key, mut receiver) = match admit(&rooms, request).await {
        Ok(session) => session,
        Err(message) => {
            send(&mut socket, Reply::Error { message }).await;
            return;
        }
    };

    if send(&mut socket, Reply::Joined { code, key }).await {
        let mut heartbeat = time::interval(Duration::from_secs(2));
        let mut last_seen = Instant::now();
        loop {
            tokio::select! {
                message = socket.recv() => match message {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        if let Ok(Request::Playback { playback }) = serde_json::from_str(&text)
                            && key.is_some() && valid(playback)
                            && let Some(room) = rooms.lock().await.get(&code)
                        {
                            room.state.send_modify(|state| state.timeline = Timeline::new(playback));
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                },
                _ = receiver.changed() => {
                    let state = *receiver.borrow_and_update();
                    if !send_state(&mut socket, state).await { break; }
                },
                _ = heartbeat.tick() => {
                    if last_seen.elapsed() > Duration::from_secs(35) { break; }
                    let state = *receiver.borrow();
                    if !send_state(&mut socket, state).await { break; }
                }
            }
        }
    }
    let guard = rooms.lock().await;
    if let Some(room) = guard.get(&code) {
        room.state.send_modify(|state| {
            state.participants -= 1;
            if key.is_some() {
                state.host_online = false;
                state.timeline = Timeline::new(Playback {
                    paused: true,
                    ..state.timeline.snapshot()
                });
            }
        });
        if room.state.borrow().participants == 0 {
            drop(guard);
            time::sleep(Duration::from_secs(45)).await;
            let mut guard = rooms.lock().await;
            if guard
                .get(&code)
                .is_some_and(|room| room.state.borrow().participants == 0)
            {
                guard.remove(&code);
            }
        }
    }
}

async fn send_state(socket: &mut WebSocket, state: RoomState) -> bool {
    send(
        socket,
        Reply::State {
            playback: state.timeline.snapshot(),
            participants: state.participants,
            host_online: state.host_online,
        },
    )
    .await
}

async fn demo_audio() -> impl IntoResponse {
    const RATE: u32 = 8_000;
    const SIZE: u32 = RATE * 90;
    let mut wave = Vec::with_capacity(SIZE as usize + 44);
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&(SIZE + 36).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&RATE.to_le_bytes());
    wave.extend_from_slice(&RATE.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&8u16.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&SIZE.to_le_bytes());
    for i in 0..SIZE {
        let tick = i % RATE;
        wave.push(if tick < 240 && tick % 20 < 10 {
            143
        } else {
            128
        });
    }
    ([(header::CONTENT_TYPE, "audio/wav")], wave)
}
