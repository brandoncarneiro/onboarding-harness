export class CheckFailed extends Error {
  constructor(message = "check failed") {
    super(message);
    this.name = "CheckFailed";
  }
}
