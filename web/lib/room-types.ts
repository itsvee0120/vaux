export type Track = {
  id: string;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: number;
  votes: number;
  addedBy: string;
};

export type Message = {
  username: string;
  text: string;
  /** Server-assigned id of the sender. Used to color-hash colliding usernames. */
  userId?: string;
  system?: boolean;
};

export type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: number;
};
