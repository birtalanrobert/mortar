/**
 * Why the server closed a socket, where the client must answer differently
 * from a connection that dropped — in the range RFC 6455 leaves to
 * applications, 4000 to 4999.
 *
 * **Superseded**: another connection of the same key took this one's place,
 * the server holding no more of them than its cap allows. Reconnecting at once
 * would only close the next oldest, and two pages of one person would take the
 * socket from each other for as long as both were open; the client polls
 * instead, and asks for a socket again only at its longest wait.
 */
export const CLOSE_SUPERSEDED = 4001;
