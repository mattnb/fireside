export function isRoomActive(input: {
  roomHasActiveWork: boolean;
  activeYolo: boolean;
}): boolean {
  return input.roomHasActiveWork || input.activeYolo;
}
