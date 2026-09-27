"use client";

import { useEffect, useRef } from "react";

type InitialBriefOptions = {
  brief?: string;
  isBusy: boolean;
  isResuming: boolean;
  contextLoading: boolean;
  messageCount: number;
  onSend: (message: string) => Promise<void>;
  onConsume: () => void;
};

export function useInitialStylistBrief({
  brief,
  isBusy,
  isResuming,
  contextLoading,
  messageCount,
  onSend,
  onConsume,
}: InitialBriefOptions) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !brief || isResuming || isBusy || contextLoading || messageCount > 0) return;
    // Eve detaches transport during effect cleanup. Like Eve's resume effect, defer
    // dispatch until Strict Mode's mount replay has settled before creating a turn.
    const timer = setTimeout(() => {
      sent.current = true;
      void onSend(brief).catch(() => {});
      onConsume();
    }, 0);
    return () => clearTimeout(timer);
  }, [brief, isBusy, isResuming, contextLoading, messageCount, onSend, onConsume]);
}
