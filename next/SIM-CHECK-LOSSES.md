# sim-check checks dropped without a replacement

`ios/Tools/sim-check.ts` is deleted. These 24 of its checks were not ported to the simulator
walkthrough (`next/walkthrough/ios.ts`) or to a HarnessKit test; the other 68 are carried by one of
those two. The checks are named `group › check` as they were in sim-check. `git log -- ios/Tools/sim-check.ts`
has the code if one is ever worth bringing back.

- sheetChecks › a conductor's child pushes inside the sheet and the back swipe returns
- sheetChecks › the dock's close button sends it away without opening it
- sheetChecks › a slow drag on the transcript moves the ticket as one piece
- sheetChecks › a slow drag on the Spec tab moves the ticket as one piece
- sheetChecks › a half drag released back shows nothing: the sheet springs back to full size
- sheetChecks › scrolling the ticket's content down and flinging it back up fast leaves the sheet open
- sheetChecks › a flick down still dismisses while the app's main thread is stalled
- sheetChecks › a swipe down from full size closes the ticket rather than docking it
- dockStackChecks › a swipe away from the presented sheet closes it and leaves the next as the docked card, no sheet
- memoryChecks › past the five live ones, more docked tickets cost about nothing
- cardStackChecks › the tickets behind the panel wait as cards just left of it, never over the sidebar
- cardStackChecks › docked, every ticket is a card in the bottom-right corner; a tap opens that one
- panelChecks › a collapsed hero sits tight above the tab strip, below the panel's buttons
- panelChecks › New session opens in the side panel with one header; with a draft typed, ✕ and Escape ask Discard or Save
- panelChecks › dragging the panel's edge resizes it, stopping at 25% and 80% of the window
- panelChecks › docking stashes the panel as a card in the bottom-right corner, and the card restores its path
- panelChecks › a panel dragged partly off the window keeps its width: its title doesn't reflow to the visible sliver
- panelChecks › holding the dragged panel in the trailing 40% shows the ghost card and docks it on release; the card restores it at its root
- panelChecks › the pop-out button moves the panel's ticket into a window of its own
- stickChecks › ${tab} stays put after the user scrolls up
- stickChecks › ${tab} follows again after scrolling back to the bottom
- stickChecks › the transcript pins the current run's header, and the next run's header takes it over
- keyboardChecksWithSoftwareKeyboard › prompt editor follows the cursor above the keyboard as the text grows
- keyboardChecksWithSoftwareKeyboard › the sheet's background runs behind the keyboard's rounded corners
