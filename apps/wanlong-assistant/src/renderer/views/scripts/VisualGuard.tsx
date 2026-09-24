import { Component, type ReactNode } from 'react';

interface VisualGuardProps {
  /** A new value (the script text) clears a caught error, so fixing the JSON brings the visual mode back. */
  resetKey: string;
  children: ReactNode;
}

/**
 * The visual mode renders whatever the JSON text says. A block with a missing required field (hand-edited JSON,
 * an old file) must not take the whole page down: the error is caught here and the page points to the JSON mode,
 * where the text is still intact.
 */
export class VisualGuard extends Component<VisualGuardProps, { error: string | null }> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(previous: VisualGuardProps): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="scriptlib-banner is-warning" role="alert">
        <strong>可视化模式显示不了这份脚本</strong>
        <span>多半是某一块缺了必填字段（{this.state.error}）。先切到 JSON 模式修好，或点「校验」看看是哪一块，再回来。</span>
      </div>
    );
  }
}
