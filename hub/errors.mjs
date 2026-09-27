export class HubError extends Error {
  constructor(message, code = 'HUB_UNAVAILABLE', status = 503) {
    super(message); this.code = code; this.status = status;
  }
}
