/** Shown instead of the whole app when there is no bridge to talk to at
 *  all — see App.tsx. Deliberately the only thing this file renders: a
 *  page with nothing to call has nothing else honest to show. */
export default function NotConnected() {
  return (
    <div className="not-connected">
      <h1>Not connected to a backend</h1>
      <p>
        This app needs to be opened through the R3 Media Hub server to reach your library and play
        anything.
      </p>
    </div>
  )
}
