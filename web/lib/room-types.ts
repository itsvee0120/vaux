export type Track = {
  id: string;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: number;
  votes: number;
  /** Plaintext display name. Undefined for private rooms — clients resolve
   *  addedById against their locally-decrypted member list. */
  addedBy?: string;
  /** Server-assigned UUID of the user who added the track. Always present. */
  addedById?: string;
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
