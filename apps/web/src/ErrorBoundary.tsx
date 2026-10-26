import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { hasError: boolean };

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BankPilot UI rendering failed', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-error" role="alert">
          <div className="app-error-card">
            <span className="section-kicker">页面遇到问题</span>
            <h1>工作台暂时无法显示</h1>
            <p>账户与交易状态仍由服务端保存。请刷新页面重试；如果问题持续，请检查本地 API 状态。</p>
            <button className="button button-primary" onClick={() => window.location.reload()}>刷新工作台</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
