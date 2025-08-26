import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "@/api/index";

interface UseVideoProgressWithAnalyticsProps {
  videoId: number;
  duration: number;
  onBackendProgressUpdate?: (progress: any) => void;
  onSpeedViolation?: (speed: number) => void;
}

const MAX_EVENTS = 100;
const MAX_ALLOWED_SPEED = 1.5;
const SPEED_CHECK_INTERVAL = 1000; // Check every 1 second

export function useVideoProgressWithAnalytics({
  videoId,
  duration,
  onBackendProgressUpdate,
  onSpeedViolation,
}: UseVideoProgressWithAnalyticsProps) {
  const api = useApi();

  const [progress, setProgress] = useState({
    totalWatchTime: 0,
    isCompleted: false,
    watchedPercentage: 0,
    skipEvents: [],
    pauseEvents: [],
  });

  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastPersistedSeconds, setLastPersistedSeconds] = useState(0);

  const lastUpdateTime = useRef<number>(0);
  const skipEventsRef = useRef<any[]>([]);
  const pauseEventsRef = useRef<any[]>([]);
  const updateTimeoutRef = useRef<NodeJS.Timeout>();
  const maxWatchedTimeRef = useRef<number>(0);
  const speedCheckIntervalRef = useRef<NodeJS.Timeout>();
  const lastProgressTimeRef = useRef<number>(0);
  const lastRealTimeRef = useRef<number>(0);
  const currentPlayerRef = useRef<any>(null);
  const [isViolationActive, setIsViolationActive] = useState(false);

  const checkPlaybackSpeed = useCallback(() => {
    if (isViolationActive) {
      return;
    }

    // console.log('=== SPEED CHECK ===');
    
    // if (!currentPlayerRef.current) {
    //   console.log('❌ No player reference available for speed check');
    //   return;
    // }

    // console.log('✅ Player reference exists');

    try {
      const internalPlayer = currentPlayerRef.current.getInternalPlayer?.() || currentPlayerRef.current;
      
      if (!internalPlayer) {
        // console.log('❌ No internal player available');
        return;
      }

      // console.log('✅ Internal player available');
      // console.log('Internal player type:', typeof internalPlayer);
      // console.log('Internal player keys:', Object.keys(internalPlayer).slice(0, 10));

      let currentTime = 0;
      let playbackRate = 1;

      if (typeof internalPlayer.currentTime === 'number') {
        currentTime = internalPlayer.currentTime;
        // console.log('✅ Current time:', currentTime);
      } else {
        // console.log('❌ Cannot get current time');
      }

      if (typeof internalPlayer.playbackRate === 'number') {
        playbackRate = internalPlayer.playbackRate;
        // console.log('✅ Playback rate:', playbackRate);
      } else {
        // console.log('❌ Cannot get playback rate');
      }

      const currentRealTime = Date.now();

      // Check playback rate first (direct method)
      if (playbackRate > MAX_ALLOWED_SPEED) {
        console.warn(`🚨 DIRECT SPEED VIOLATION: ${playbackRate}x > ${MAX_ALLOWED_SPEED}x`);
        setIsViolationActive(true);
        if (onSpeedViolation) {
          // console.log('🚨 Calling onSpeedViolation callback');
          onSpeedViolation(playbackRate);
        } else {
          // console.log('❌ No onSpeedViolation callback available');
        }
        return;
      }

      // Check progress-based speed detection (indirect method)
      if (lastProgressTimeRef.current > 0 && lastRealTimeRef.current > 0) {
        const timeDiff = currentTime - lastProgressTimeRef.current;
        const realTimeDiff = (currentRealTime - lastRealTimeRef.current) / 1000;

        // console.log(`Time diff: ${timeDiff}s, Real time diff: ${realTimeDiff}s`);

        if (realTimeDiff > 0.5 && timeDiff > 0) {
          const detectedSpeed = timeDiff / realTimeDiff;
          // console.log(`Calculated speed: ${detectedSpeed.toFixed(2)}x`);
          
          // Only trigger if significantly above threshold to avoid false positives
          if (detectedSpeed > MAX_ALLOWED_SPEED + 0.2) {
            console.warn(`🚨 CALCULATED SPEED VIOLATION: ${detectedSpeed.toFixed(2)}x`);
            setIsViolationActive(true);
            if (onSpeedViolation) {
              // console.log('🚨 Calling onSpeedViolation callback');
              onSpeedViolation(detectedSpeed);
            } else {
              // console.log('❌ No onSpeedViolation callback available');
            }
            return;
          }
        }
      }

      lastProgressTimeRef.current = currentTime;
      lastRealTimeRef.current = currentRealTime;
      
    } catch (error) {
      console.error('❌ Error in speed check:', error);
    }
  }, [onSpeedViolation, isViolationActive]);

  // Set player reference for speed monitoring - Updated for ReactPlayer v3
  const setPlayerRef = useCallback((playerRef: any) => {
    // console.log('=== SETTING PLAYER REF ===');
    // console.log('Player ref received:', !!playerRef);
    // console.log('Player ref type:', typeof playerRef);
    // console.log('Player ref keys:', playerRef ? Object.keys(playerRef) : 'none');
    
    // Clear existing interval
    if (speedCheckIntervalRef.current) {
      // console.log('Clearing existing speed check interval');
      clearInterval(speedCheckIntervalRef.current);
      speedCheckIntervalRef.current = undefined;
    }

    // Store the player reference
    currentPlayerRef.current = playerRef;

    if (playerRef) {
      // console.log('Starting speed monitoring interval every', SPEED_CHECK_INTERVAL, 'ms');
      
      // Start monitoring playback speed
      const intervalId = setInterval(() => {
        checkPlaybackSpeed();
      }, SPEED_CHECK_INTERVAL);
      
      speedCheckIntervalRef.current = intervalId;
      // console.log('Speed monitoring interval created with ID:', intervalId);

      // Also check immediately after a delay
      setTimeout(() => {
        // console.log('Running initial speed check...');
        checkPlaybackSpeed();
      }, 10000);
    } else {
      // console.log('No player ref provided, speed monitoring disabled');
    }
  }, [checkPlaybackSpeed]);

  // Unified analytics event sender
  const sendAnalyticsEvent = useCallback(
    async (eventType: string, data: any) => {
      try {
        await api.post("/analytics/event", { eventType, videoId, ...data });
      } catch (err) {
        console.error("Failed to send analytics event", err);
      }
    },
    [api, videoId]
  );

  const retryAttempts = useRef(0);

  // Simplified backend progress update (removed speed validation from backend)
  const debouncedUpdate = useCallback(
    (progressData: Partial<typeof progress>) => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }

      const progressToSend = { ...progressData };
      progressToSend.skipEvents = (progressToSend.skipEvents || []).slice(-MAX_EVENTS);
      progressToSend.pauseEvents = (progressToSend.pauseEvents || []).slice(-MAX_EVENTS);

      updateTimeoutRef.current = setTimeout(async () => {
        try {
          const response = await api.post(`/videos/${videoId}/progress`, progressToSend);
          // console.log("Backend progress updated:", response.data.progress);
          setError(null);
          setLastPersistedSeconds(progressToSend.totalWatchTime || 0);
          retryAttempts.current = 0;
        } catch (err: any) {
          console.error("Progress update failed:", err);
          
          // Handle different types of backend errors
          if (err.response?.status === 400) {
            const errorCode = err.response.data?.code;
            const errorData = err.response.data?.details || {};
            
            switch (errorCode) {
              case 'SPEED_VIOLATION':
                if (onSpeedViolation) {
                  onSpeedViolation(errorData.detectedSpeed || 2.0);
                }
                setError('Please watch videos at normal speed for effective learning.');
                break;
                
              case 'EXCESSIVE_SKIPPING':
                if (onSpeedViolation) {
                  // Use speed violation modal for skipping too
                  onSpeedViolation(1.0); // Normal speed but show modal
                }
                setError('Excessive skipping detected. Please watch sequentially.');
                break;
                
              case 'DURATION_OVERFLOW':
              case 'DURATION_EXCEEDED':
                setError('Watch time error. Please refresh and watch normally.');
                break;
                
              case 'INVALID_INPUT':
                setError('Invalid progress data. Please refresh the page.');
                break;
                
              default:
                setError(err.response.data?.error || 'Failed to save progress');
            }
            
            // Don't retry on validation errors
            return;
          } 
          
          // Retry logic for network errors only
          if (retryAttempts.current < 3) {
            retryAttempts.current++;
            const delay = Math.pow(2, retryAttempts.current) * 1000;
            updateTimeoutRef.current = setTimeout(() => debouncedUpdate(progressData), delay);
          } else {
            setError("Failed to save progress. Please refresh and try again.");
          }
        }
      }, 10000);
    },
    [api, videoId, onSpeedViolation]
  );

  // Handle progress event with immediate UI updates
const handleProgress = useCallback(
  (progressEvent: { played: number; playedSeconds: number }) => {
    if (isViolationActive) {
      // console.log('Progress update blocked - violation active');
      return;
    }

    const playedSeconds = Math.max(0, progressEvent.playedSeconds || 0);

    // Initialize if undefined
    if (typeof maxWatchedTimeRef.current !== 'number') {
      maxWatchedTimeRef.current = 0;
    }

    // Relax progress rejection: allow minor regressions and forward jumps up to 10s
    const newMaxWatchTime = Math.max(maxWatchedTimeRef.current, playedSeconds);

    if (
      playedSeconds >= maxWatchedTimeRef.current - 2 && // allow 2s regressions
      newMaxWatchTime <= maxWatchedTimeRef.current + 10 // allow forward jumps up to 10s
    ) {
      maxWatchedTimeRef.current = newMaxWatchTime;

      const watchedPercentage = duration > 0 ? Math.min((newMaxWatchTime / duration) * 100, 100) : 0;

      const newProgress = {
        watchedPercentage,
        totalWatchTime: newMaxWatchTime,
        isCompleted: watchedPercentage >= 95,
        skipEvents: skipEventsRef.current,
        pauseEvents: pauseEventsRef.current,
      };

      setProgress(prev => ({ ...prev, ...newProgress }));

      if (onBackendProgressUpdate) {
        // console.log('Progress update sent to parent:', newProgress);
        onBackendProgressUpdate(newProgress);
      }

      // Throttle backend updates every 5 seconds
      const now = Date.now();
      if (now - lastUpdateTime.current > 5000) {
        lastUpdateTime.current = now;
        sendAnalyticsEvent("video_progress", {
          currentTime: playedSeconds,
          percentWatched: watchedPercentage,
        });

        debouncedUpdate(newProgress);
      }
    } else {
      // console.log(`Invalid progress rejected: ${playedSeconds}s vs max ${maxWatchedTimeRef.current}s`);
    }
  },
  [duration, sendAnalyticsEvent, debouncedUpdate, onBackendProgressUpdate, isViolationActive]
);

  // Handle play event
  const handlePlay = useCallback(
    (currentTime: number) => {
      sendAnalyticsEvent("video_play", { currentTime });
      // Reset speed monitoring when play starts
      lastProgressTimeRef.current = 0;
      lastRealTimeRef.current = 0;
    },
    [sendAnalyticsEvent]
  );

  // Handle pause event
  const handlePause = useCallback(
    (currentTime: number) => {
      const pauseEvent = { timestamp: Date.now(), currentTime };
      pauseEventsRef.current.push(pauseEvent);
      sendAnalyticsEvent("video_pause", { currentTime });
    },
    [sendAnalyticsEvent]
  );

  // Handle seek event
  const handleSeek = useCallback(
    (from: number, to: number) => {
      // Don't process seeks if violation is active
      if (isViolationActive) {
        return;
      }

      const skipEvent = { timestamp: Date.now(), from, to };
      skipEventsRef.current.push(skipEvent);
      sendAnalyticsEvent("video_seek", { seekFrom: from, seekTo: to });
      
      // Check for excessive skipping
      const skipDistance = Math.abs(to - from);
      const isLargeSkip = skipDistance > 30; // More than 30 seconds
      const isForwardSkip = to > from;
      
      // console.log(`Seek detected: ${from.toFixed(1)}s -> ${to.toFixed(1)}s (${skipDistance.toFixed(1)}s skip)`);
      
      // Check recent skip events for excessive skipping pattern
      const now = Date.now();
      const recentSkips = skipEventsRef.current.filter(event => 
        now - event.timestamp < 30000 && // Within last 30 seconds
        Math.abs(event.to - event.from) > 10 // Skip more than 10 seconds
      );
      
      // console.log(`Recent skips in last 30s: ${recentSkips.length}`);
      
      // Trigger violation if:
      // 1. Single large forward skip (>60 seconds), OR
      // 2. Multiple skips (>3) in short time
      if (
        (isForwardSkip && skipDistance > 60) || 
        recentSkips.length > 3
      ) {
        console.warn(`🚨 EXCESSIVE SKIPPING DETECTED: ${skipDistance}s skip, ${recentSkips.length} recent skips`);
        setIsViolationActive(true);
        if (onSpeedViolation) {
          // Use speed 1.0 to indicate this is a skipping violation, not speed
          onSpeedViolation(1.0);
        }
        return;
      }
      
      // Reset speed monitoring after seek
      lastProgressTimeRef.current = 0;
      lastRealTimeRef.current = 0;
    },
    [sendAnalyticsEvent, onSpeedViolation, isViolationActive]
  );

  // Handle video ended event
  const handleEnded = useCallback(() => {
    const finalProgress = {
      watchedPercentage: 100,
      isCompleted: true,
      totalWatchTime: duration,
      skipEvents: skipEventsRef.current,
      pauseEvents: pauseEventsRef.current,
    };
    
    maxWatchedTimeRef.current = duration;
    setProgress((prev) => ({ ...prev, ...finalProgress }));

    // Notify parent immediately
    if (onBackendProgressUpdate) {
      onBackendProgressUpdate(finalProgress);
    }

    sendAnalyticsEvent("video_ended", {});

    // Immediately update backend on video end
    api
      .post(`/videos/${videoId}/progress`, finalProgress)
      .then((res) => {
        setLastPersistedSeconds(finalProgress.totalWatchTime || duration);
        // console.log("Video completion saved:", res.data.progress);
      })
      .catch((err) => console.error("Failed to save completion:", err));
  }, [api, videoId, duration, onBackendProgressUpdate, sendAnalyticsEvent]);

  // Load initial progress from backend
useEffect(() => {
  const loadProgress = async () => {
    try {
      setIsLoading(true);
      const res = await api.get(`/videos/${videoId}`);
      const videoData = res.data.video;
      const initialProgress = videoData.progress || {
        totalWatchTime: 0,
        isCompleted: false,
        watchedPercentage: 0,
        skipEvents: [],
        pauseEvents: [],
      };

      maxWatchedTimeRef.current = initialProgress.totalWatchTime || 0;

      setProgress(initialProgress);
      setLastPersistedSeconds(initialProgress.totalWatchTime || 0);
      skipEventsRef.current = initialProgress.skipEvents || [];
      pauseEventsRef.current = initialProgress.pauseEvents || [];

      if (onBackendProgressUpdate) {
        onBackendProgressUpdate(initialProgress);
      }
    } catch (error) {
      setError("Failed to load progress");
      console.error("Failed to load progress:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (videoId > 0) loadProgress();

  return () => {
    if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
    if (speedCheckIntervalRef.current) clearInterval(speedCheckIntervalRef.current);
  };
}, [api, videoId, onBackendProgressUpdate]);


  // Reset violation state (called when modal is dismissed)
  const resetViolationState = useCallback(() => {
    // console.log('Resetting violation state');
    setIsViolationActive(false);
    // Reset speed monitoring
    lastProgressTimeRef.current = 0;
    lastRealTimeRef.current = 0;
  }, []);

  return {
    progress,
    error,
    isLoading,
    lastPersistedSeconds,
    handleProgress,
    handlePlay,
    handlePause,
    handleSeek,
    handleEnded,
    setPlayerRef, // Expose this to VideoPlayer component
    resetViolationState, // New: expose this to reset violation state
  };
}