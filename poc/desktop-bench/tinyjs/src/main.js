// Throwaway envelope: retain TinyJS's real JS backend and native window.
export const api = {
  target: () => {
    const url = tjs.env.GHL_DESKTOP_BENCH_URL
    if (!url?.startsWith('http://127.0.0.1:')) throw new Error('Missing local benchmark URL')
    return url
  },
}
