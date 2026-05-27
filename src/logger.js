function stamp() {
  return new Date().toISOString();
}

export const logger = {
  info(message, data) {
    console.log(JSON.stringify({ level: "info", time: stamp(), message, ...data }));
  },
  warn(message, data) {
    console.warn(JSON.stringify({ level: "warn", time: stamp(), message, ...data }));
  },
  error(message, error, data) {
    console.error(
      JSON.stringify({
        level: "error",
        time: stamp(),
        message,
        error: error?.message || String(error),
        stack: error?.stack,
        ...data
      })
    );
  }
};
