import { useRef, useState, useEffect, useCallback, RefObject } from "react";
import { Virtualizer } from "@tanstack/react-virtual";

interface UseAutoScrollProps {
    scrollRef: RefObject<HTMLDivElement | null>;
    segments: any[];
    isRecording: boolean;
    isPaused: boolean;
    activeSegmentId?: string;
    virtualizer?: Virtualizer<HTMLDivElement, Element>;
    virtualizationThreshold?: number;
    disableAutoScroll?: boolean; // Completely disable auto-scroll behavior (for meeting details page)
}

interface UseAutoScrollReturn {
    autoScroll: boolean;
    setAutoScroll: (value: boolean) => void;
    scrollToBottom: () => void;
}

// Threshold in pixels to consider "at the bottom"
const SCROLL_THRESHOLD = 100;

/**
 * Custom hook to manage auto-scrolling behavior for transcript
 *
 * Features:
 * - Auto-scrolls to bottom when new content arrives during recording
 * - Pauses auto-scroll when user manually scrolls up
 * - Resumes auto-scroll when user scrolls back to the bottom
 *
 * @param segments - Array of transcript segments
 * @param isRecording - Whether recording is in progress
 * @param isPaused - Whether recording is paused
 * @param activeSegmentId - ID of the currently active segment
 * @returns Scroll ref, auto-scroll state, and scroll control functions
 */
export function useAutoScroll({
    scrollRef,
    segments,
    isRecording,
    isPaused,
    activeSegmentId,
    virtualizer,
    virtualizationThreshold = 10,
    disableAutoScroll = false,
}: UseAutoScrollProps): UseAutoScrollReturn {
    const useVirtualization = virtualizer && segments.length >= virtualizationThreshold;
    const [autoScroll, setAutoScroll] = useState(true);
    // Ref to always have current autoScroll value in effects
    const autoScrollRef = useRef(autoScroll);
    autoScrollRef.current = autoScroll;

    // Track if user has manually scrolled up (to disable auto-scroll temporarily)
    const userScrolledRef = useRef(!autoScroll);
    userScrolledRef.current = !autoScroll;
    // Track if we're doing a programmatic scroll
    const isProgrammaticScrollRef = useRef(false);

    /**
     * Check if the user is scrolled near the bottom
     */
    const isNearBottom = useCallback(() => {
        if (!scrollRef.current) return true;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    }, [scrollRef]);

    /**
     * Scroll to bottom programmatically
     */
    const scrollToBottom = useCallback(() => {
        if (!scrollRef.current) return;
        isProgrammaticScrollRef.current = true;
        setAutoScroll(true);

        if (useVirtualization && virtualizer) {
            const count = segments.length;
            if (count > 0) {
                virtualizer.scrollToIndex(count - 1, { align: "end" });
            }
            const totalSize = virtualizer.getTotalSize();
            virtualizer.scrollToOffset(totalSize + 2000, { align: "end" });
        }
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }

        setTimeout(() => {
            if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            isProgrammaticScrollRef.current = false;
        }, 80);
    }, [scrollRef, useVirtualization, virtualizer, segments.length]);

    // Detect explicit wheel UP to pause auto-scroll
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            if (e.deltaY < 0) {
                setAutoScroll(false);
            }
        };

        container.addEventListener("wheel", handleWheel, { passive: true });
        return () => {
            container.removeEventListener("wheel", handleWheel);
        };
    }, [scrollRef]);

    // Handle scroll events to detect manual scrolling
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
        let lastScrollTop = container.scrollTop;

        const handleScroll = () => {
            if (isProgrammaticScrollRef.current) {
                lastScrollTop = container.scrollTop;
                return;
            }

            const currentScrollTop = container.scrollTop;
            const scrollingUp = currentScrollTop < lastScrollTop - 4;
            lastScrollTop = currentScrollTop;

            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }

            scrollTimeout = setTimeout(() => {
                const nearBottom = isNearBottom();
                if (nearBottom) {
                    // User scrolled back to bottom - resume auto-scroll
                    setAutoScroll(true);
                } else if (scrollingUp) {
                    // User explicitly scrolled up
                    setAutoScroll(false);
                }
            }, 60);
        };

        container.addEventListener("scroll", handleScroll, { passive: true });

        return () => {
            container.removeEventListener("scroll", handleScroll);
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
        };
    }, [isNearBottom, scrollRef]);

    // Key tracking both new segments and streaming word additions to the latest segment
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
    const lastSegmentKey = lastSegment
        ? `${segments.length}:${lastSegment.id ?? ''}:${(lastSegment.text ?? '').length}`
        : '0';

    // Auto-scroll to bottom when content arrives during recording
    useEffect(() => {
        if (disableAutoScroll) {
            return;
        }

        if (autoScrollRef.current && isRecording && !isPaused && segments.length > 0) {
            scrollToBottom();
        }
    }, [lastSegmentKey, isRecording, isPaused, disableAutoScroll, scrollToBottom, segments.length]);

    // Auto-scroll to active segment (when clicking on search results, etc.)
    useEffect(() => {
        if (activeSegmentId) {
            isProgrammaticScrollRef.current = true;

            if (useVirtualization && virtualizer) {
                const index = segments.findIndex((s: any) => s.id === activeSegmentId);
                if (index >= 0) {
                    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
                }
            } else {
                const element = document.getElementById(`segment-${activeSegmentId}`);
                if (element) {
                    element.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }

            // Reset the flag after scroll animation completes
            setTimeout(() => {
                isProgrammaticScrollRef.current = false;
            }, 500);
        }
    }, [activeSegmentId, useVirtualization, virtualizer, segments]);

    return {
        autoScroll,
        setAutoScroll,
        scrollToBottom,
    };
}
