/** A move the server told this participant about. */
export interface IMove {
    countdownSeconds: number;
    destination: string;
    moveId: string;

    /** The token that lets this participant into the destination, and only there. */
    token: string;
}
