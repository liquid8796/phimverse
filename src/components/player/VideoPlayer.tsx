"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  PictureInPicture2,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type Hls from "hls.js";
import type { EpisodeSource, StreamType } from "@/types";
import { resolutionLabel } from "@/lib/constants";
import { clamp, cn, formatClock } from "@/lib/utils";

/**
 * Custom video player.
 *
 * Source strategy: asks /api/stream/:id?format=json for the resolved media URL
 * and plays it directly, so every Range request (seeks, 4K buffering) goes
 * straight to the CDN (OneDrive/Microsoft CDN) — the app server is touched
 * exactly once per session. If the pre-signed URL expires mid-playback
 * (~1 hour), the player transparently re-resolves and resumes.
 */

interface VideoPlayerProps {
  episodeId: string;
  movieId: string;
  poster?: string;
  title: string;
  subtitle?: string;
  initialPosition: number;
  /** Next episode link, shown in the control bar for series. */
  nextHref?: string | null;
  /** Whether progress should be persisted (user signed in). */
  saveProgress: boolean;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoPlayer({
  episodeId,
  movieId,
  poster,
  title,
  subtitle,
  initialPosition,
  nextHref,
  saveProgress,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumedRef = useRef(false);
  const recoveringRef = useRef(false);
  /** Viewer-chosen resolution, kept across expiry-recovery re-resolves. */
  const resolutionRef = useRef<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [resolution, setResolution] = useState<string | null>(null);
  const [available, setAvailable] = useState<EpisodeSource[]>([]);
  const [pipSupported, setPipSupported] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Transient toast inside the player (e.g. why PiP was refused). */
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3200);
  }, []);

  // Feature-detect PiP once mounted; hide the button where unsupported (Firefox).
  useEffect(() => {
    const video = videoRef.current;
    setPipSupported(
      "pictureInPictureEnabled" in document &&
        document.pictureInPictureEnabled &&
        Boolean(video && typeof video.requestPictureInPicture === "function") &&
        !video?.disablePictureInPicture,
    );
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // Track PiP state from the element events (covers the floating window's own X button).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (video.readyState < 1) {
        showNotice("Video chưa tải xong — thử lại sau giây lát.");
        return;
      }
      await video.requestPictureInPicture();
    } catch (err) {
      console.error("Picture-in-Picture failed:", err);
      showNotice("Trình duyệt đang chặn Thu nhỏ cửa sổ (PiP) — kiểm tra cài đặt site permissions.");
    }
  }, [showNotice]);

  /** Resolve the stream (optionally at a specific resolution) and attach it. */
  const attachSource = useCallback(
    async (resumeAt?: number, preferredRes?: string) => {
      const video = videoRef.current;
      if (!video) return;
      setError(null);
      setWaiting(true);
      try {
        const wanted = preferredRes ?? resolutionRef.current;
        const query = wanted ? `&res=${encodeURIComponent(wanted)}` : "";
        const res = await fetch(`/api/stream/${episodeId}?format=json${query}`);
        if (!res.ok) throw new Error(`stream resolve failed: ${res.status}`);
        const source = (await res.json()) as {
          url: string;
          type: StreamType;
          resolution: string;
          available: EpisodeSource[];
        };
        resolutionRef.current = source.resolution;
        setResolution(source.resolution);
        setAvailable(source.available ?? []);

        hlsRef.current?.destroy();
        hlsRef.current = null;

        const isHls = source.type === "hls" || source.url.includes(".m3u8");
        if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
          const { default: HlsClass } = await import("hls.js");
          if (HlsClass.isSupported()) {
            const hls = new HlsClass({ maxBufferLength: 60, backBufferLength: 30 });
            hls.loadSource(source.url);
            hls.attachMedia(video);
            hlsRef.current = hls;
          } else {
            video.src = source.url;
          }
        } else {
          video.src = source.url;
        }

        if (resumeAt && resumeAt > 0) {
          const onLoaded = () => {
            video.currentTime = resumeAt;
            video.play().catch(() => undefined);
            video.removeEventListener("loadedmetadata", onLoaded);
          };
          video.addEventListener("loadedmetadata", onLoaded);
        }
      } catch (err) {
        console.error(err);
        setError("Không tải được nguồn phát. Vui lòng thử lại.");
        setWaiting(false);
      }
    },
    [episodeId],
  );

  /** Switch quality in place: re-resolve and resume at the current position. */
  const switchResolution = useCallback(
    (nextRes: string) => {
      setQualityMenuOpen(false);
      if (nextRes === resolutionRef.current) return;
      const video = videoRef.current;
      attachSource(video && video.currentTime > 0 ? video.currentTime : undefined, nextRes);
    },
    [attachSource],
  );

  useEffect(() => {
    resumedRef.current = false;
    // Deferred so the initial resolve doesn't set state synchronously in the effect.
    const timer = setTimeout(() => attachSource(), 0);
    return () => {
      clearTimeout(timer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [attachSource]);

  /** Persist progress (beacon-friendly: fires on unload too). */
  const persistProgress = useCallback(() => {
    const video = videoRef.current;
    if (!saveProgress || !video || !video.duration || Number.isNaN(video.duration)) return;
    const payload = JSON.stringify({
      episodeId,
      movieId,
      position: video.currentTime,
      duration: video.duration,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/progress", new Blob([payload], { type: "text/plain" }));
    } else {
      fetch("/api/progress", { method: "POST", body: payload, keepalive: true }).catch(
        () => undefined,
      );
    }
  }, [episodeId, movieId, saveProgress]);

  useEffect(() => {
    if (!saveProgress) return;
    const interval = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) persistProgress();
    }, 10_000);
    const onHide = () => persistProgress();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(interval);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      persistProgress();
    };
  }, [persistProgress, saveProgress]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) {
        setControlsVisible(false);
        setRateMenuOpen(false);
        setQualityMenuOpen(false);
      }
    }, 2600);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
    showControls();
  }, [showControls]);

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video || !video.duration) return;
      video.currentTime = clamp(video.currentTime + seconds, 0, video.duration);
      showControls();
    },
    [showControls],
  );

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen().catch(() => undefined);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
          seekBy(-10);
          break;
        case "arrowright":
          seekBy(10);
          break;
        case "arrowup": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) {
            v.volume = clamp(v.volume + 0.1, 0, 1);
            v.muted = false;
          }
          break;
        }
        case "arrowdown": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) v.volume = clamp(v.volume - 0.1, 0, 1);
          break;
        }
        case "m": {
          const v = videoRef.current;
          if (v) v.muted = !v.muted;
          break;
        }
        case "f":
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekBy, togglePlay, toggleFullscreen]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (video.buffered.length > 0) {
      setBuffered(video.buffered.end(video.buffered.length - 1));
    }
  };

  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setWaiting(false);
    // Resume once per episode view.
    if (!resumedRef.current && initialPosition > 5 && initialPosition < video.duration * 0.95) {
      video.currentTime = initialPosition;
      resumedRef.current = true;
    }
  };

  /** Expired pre-signed URL mid-playback → re-resolve once and resume. */
  const onVideoError = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!recoveringRef.current && video.currentTime > 0) {
      recoveringRef.current = true;
      const at = video.currentTime;
      attachSource(at).finally(() => {
        setTimeout(() => {
          recoveringRef.current = false;
        }, 5000);
      });
    } else {
      setError("Không phát được video. Nguồn phát có thể tạm thời gián đoạn.");
      setWaiting(false);
    }
  };

  const played = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      onMouseMove={showControls}
      onTouchStart={showControls}
      className={cn(
        "group relative w-full overflow-hidden bg-black",
        fullscreen ? "h-full" : "aspect-video rounded-2xl ring-1 ring-line/60",
      )}
    >
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          showControls();
        }}
        onPause={() => {
          setPlaying(false);
          setControlsVisible(true);
          persistProgress();
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onVolumeChange={() => {
          const v = videoRef.current;
          if (v) {
            setVolume(v.volume);
            setMuted(v.muted);
          }
        }}
        onRateChange={() => setRate(videoRef.current?.playbackRate ?? 1)}
        onError={onVideoError}
        onEnded={persistProgress}
        className="h-full w-full"
      />

      {/* Buffering spinner */}
      {waiting && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Loader2 className="size-14 animate-spin text-white/80" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center">
          <div>
            <p className="text-sm text-white/90">{error}</p>
            <button
              type="button"
              onClick={() => attachSource(currentTime)}
              className="mt-4 rounded-full bg-neon px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              Thử lại
            </button>
          </div>
        </div>
      )}

      {/* Center play button when paused */}
      {!playing && !waiting && !error && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Phát"
          className="absolute inset-0 m-auto grid size-20 place-items-center rounded-full bg-neon/90 text-white shadow-2xl shadow-neon/40 transition-transform hover:scale-105"
        >
          <Play className="ml-1 size-9 fill-current" />
        </button>
      )}

      {/* Transient notice toast */}
      {notice && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/85 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-md">
          {notice}
        </div>
      )}

      {/* Top title bar */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent p-4 transition-opacity duration-300",
          controlsVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <p className="text-sm font-semibold text-white md:text-base">{title}</p>
        {subtitle && <p className="text-xs text-white/70 md:text-sm">{subtitle}</p>}
      </div>

      {/* Control bar */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10 transition-opacity duration-300",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* Seek bar */}
        <div className="group/seek relative h-4 cursor-pointer">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            aria-label="Tua video"
            onChange={(e) => {
              const video = videoRef.current;
              if (video) video.currentTime = Number(e.target.value);
            }}
            className="absolute inset-0 z-10 w-full cursor-pointer opacity-0"
          />
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20 transition-all group-hover/seek:h-1.5">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/35"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-neon"
              style={{ width: `${played}%` }}
            />
            <div
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neon opacity-0 shadow transition-opacity group-hover/seek:opacity-100"
              style={{ left: `${played}%` }}
            />
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-white md:gap-3">
          <ControlButton label={playing ? "Tạm dừng" : "Phát"} onClick={togglePlay}>
            {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
          </ControlButton>
          <ControlButton label="Lùi 10 giây" onClick={() => seekBy(-10)}>
            <RotateCcw className="size-4.5" />
          </ControlButton>
          <ControlButton label="Tới 10 giây" onClick={() => seekBy(10)}>
            <RotateCw className="size-4.5" />
          </ControlButton>

          {nextHref && (
            <Link
              href={nextHref}
              aria-label="Tập tiếp theo"
              className="grid size-9 place-items-center rounded-full transition-colors hover:bg-white/15"
            >
              <SkipForward className="size-4.5" />
            </Link>
          )}

          {/* Volume */}
          <div className="group/vol flex items-center gap-2">
            <ControlButton
              label={muted ? "Bật tiếng" : "Tắt tiếng"}
              onClick={() => {
                const v = videoRef.current;
                if (v) v.muted = !v.muted;
              }}
            >
              {muted || volume === 0 ? (
                <VolumeX className="size-4.5" />
              ) : (
                <Volume2 className="size-4.5" />
              )}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Âm lượng"
              onChange={(e) => {
                const v = videoRef.current;
                if (v) {
                  v.volume = Number(e.target.value);
                  v.muted = false;
                }
              }}
              className="h-1 w-0 cursor-pointer accent-neon opacity-0 transition-all duration-300 group-hover/vol:w-20 group-hover/vol:opacity-100"
            />
          </div>

          <span className="ml-1 text-xs tabular-nums text-white/80 md:text-sm">
            {formatClock(currentTime)} / {formatClock(duration)}
          </span>

          <div className="ml-auto flex items-center gap-1 md:gap-2">
            {/* Quality selector */}
            {available.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setQualityMenuOpen((v) => !v);
                    setRateMenuOpen(false);
                  }}
                  aria-label="Chọn chất lượng"
                  className={cn(
                    "rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors hover:bg-white/15 md:text-sm",
                    resolution === "2160p" && "text-amber-300",
                  )}
                >
                  {resolution ? resolutionLabel(resolution) : "Auto"}
                </button>
                {qualityMenuOpen && (
                  <div className="absolute bottom-10 right-0 w-32 overflow-hidden rounded-xl border border-white/10 bg-black/90 py-1 backdrop-blur-md">
                    <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50">
                      Chất lượng
                    </p>
                    {available.map((variant) => (
                      <button
                        key={variant.resolution}
                        type="button"
                        onClick={() => switchResolution(variant.resolution)}
                        className={cn(
                          "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10",
                          variant.resolution === resolution ? "text-neon" : "text-white/85",
                        )}
                      >
                        {resolutionLabel(variant.resolution)}
                        {variant.resolution === "2160p" && (
                          <span className="rounded bg-amber-400/20 px-1 text-[10px] font-bold text-amber-300">
                            UHD
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Playback rate */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setRateMenuOpen((v) => !v);
                  setQualityMenuOpen(false);
                }}
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-white/15 md:text-sm"
              >
                {rate}x
              </button>
              {rateMenuOpen && (
                <div className="absolute bottom-10 right-0 w-24 overflow-hidden rounded-xl border border-white/10 bg-black/90 py-1 backdrop-blur-md">
                  {RATES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        const v = videoRef.current;
                        if (v) v.playbackRate = r;
                        setRateMenuOpen(false);
                      }}
                      className={cn(
                        "block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/10",
                        r === rate ? "text-neon" : "text-white/85",
                      )}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {pipSupported && (
              <ControlButton
                label={pipActive ? "Thoát thu nhỏ cửa sổ" : "Thu nhỏ trong cửa sổ"}
                onClick={togglePip}
              >
                <PictureInPicture2 className={cn("size-4.5", pipActive && "text-neon")} />
              </ControlButton>
            )}
            <ControlButton
              label={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize className="size-4.5" /> : <Maximize className="size-4.5" />}
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-full transition-colors hover:bg-white/15"
    >
      {children}
    </button>
  );
}
