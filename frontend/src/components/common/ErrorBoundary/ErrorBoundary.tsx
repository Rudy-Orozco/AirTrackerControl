import { Component, type ReactNode } from 'react'

/**
 * Hides its children if they throw while rendering, instead of letting React
 * unmount the whole app (a black screen). For parts that show third-party data
 * (weather), where an unexpected report shouldn't take the map down with it.
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(`${this.props.name} failed to render:`, error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
