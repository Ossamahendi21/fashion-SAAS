"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common/error-alert";

type SectionBoundaryProps = {
  children: ReactNode;
  title: string;
  /** Shown instead of the thrown message when the error is not worth surfacing verbatim. */
  message?: string;
};

type SectionBoundaryState = { error: Error | null };

/**
 * Keeps one panel's render-time failure off the rest of the page — Clerk's `<PricingTable />`
 * throws outright when Billing is not enabled on the instance, which would otherwise take
 * the whole billing route to the route-level error boundary.
 */
export class SectionBoundary extends Component<SectionBoundaryProps, SectionBoundaryState> {
  state: SectionBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SectionBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SectionBoundary caught an error", error, info.componentStack);
    // Once per failure: the inline alert is easy to miss halfway down a long page.
    toast.error(this.props.message ?? this.props.title);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorAlert
        title={this.props.title}
        message={this.props.message ?? error.message ?? "Please try again."}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
