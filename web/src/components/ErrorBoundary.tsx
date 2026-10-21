import { Component, type ErrorInfo, type ReactNode } from "react";

/** Shows a page's error instead of a blank screen, and recovers when you navigate elsewhere. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner error">
        <span className="grow">
          <b>This page couldn't be shown.</b> {this.state.error.message}
        </span>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
