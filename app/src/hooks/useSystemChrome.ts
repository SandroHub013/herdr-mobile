import { useEffect, useRef, useState } from 'react';
import { EmitterSubscription, Keyboard, KeyboardEvent, Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * System insets and keyboard geometry.
 *
 * The app draws edge to edge (the Android theme makes both system bars
 * transparent), so nothing is inset for us: the status bar would sit on top of
 * the header and the navigation bar on top of the composer.
 *
 * The insets come from the system. Guessing them from the window size looked
 * fine on a phone with gesture navigation, where the bar is a thin pill, and
 * hid the composer's key row on a phone with the three-button bar, which is
 * twice as tall and reported through no dimension the window exposes.
 */
export interface SystemChrome {
  width: number;
  height: number;
  isLandscape: boolean;
  /** Space to leave clear at the top for the status bar. */
  topInset: number;
  /** Space to leave clear at the bottom for the navigation bar or gesture pill. */
  bottomInset: number;
  keyboardVisible: boolean;
  /** Bottom padding the composer needs while the keyboard is open. */
  keyboardOffset: number;
}

/** Used only until the system has reported the real status bar height. */
function statusBarFallback(isLandscape: boolean): number {
  if (Platform.OS === 'android') {
    // A reported height of zero happens on some devices; never trust it blindly.
    return Math.max(StatusBar.currentHeight ?? 0, 24);
  }
  return isLandscape ? 0 : 44;
}

export function useSystemChrome(): SystemChrome {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  /** Window height with the keyboard closed, used to detect whether Android resized us. */
  const restingHeightRef = useRef(height);
  /**
   * Navigation bar inset taken while the keyboard was closed. Some Android
   * versions fold the keyboard into the bottom inset while it is open, and
   * that would count it twice.
   */
  const restingBottomRef = useRef(insets.bottom);

  useEffect(() => {
    const onShow = (event: KeyboardEvent) => {
      const measured = event?.endCoordinates?.height ?? 0;
      if (measured > 0) setKeyboardHeight(measured);
      setKeyboardVisible(true);
    };
    const onHide = () => {
      setKeyboardHeight(0);
      setKeyboardVisible(false);
    };

    const subscriptions: EmitterSubscription[] = [
      Keyboard.addListener('keyboardDidShow', onShow),
      Keyboard.addListener('keyboardDidHide', onHide),
    ];
    if (Platform.OS === 'ios') {
      subscriptions.push(Keyboard.addListener('keyboardWillShow', onShow));
      subscriptions.push(Keyboard.addListener('keyboardWillHide', onHide));
    }

    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);

  if (!keyboardVisible) {
    restingHeightRef.current = height;
    restingBottomRef.current = insets.bottom;
  }

  // In landscape the bar moves to the side and the bottom inset is zero; a
  // little room keeps the composer off the edge of the glass.
  const bottomInset = Math.max(isLandscape ? 12 : 0, restingBottomRef.current);

  // Android may resize the window for the keyboard or, under edge to edge, leave it
  // alone. Pad by whatever the resize did not absorb, plus the navigation bar: the
  // reported keyboard height is measured from the top of that bar, not from the
  // bottom of the screen, and the difference is exactly what used to clip the
  // composer's key row behind the keyboard.
  const absorbedByResize = Math.max(0, restingHeightRef.current - height);
  const keyboardOffset = keyboardVisible
    ? Math.max(0, keyboardHeight - absorbedByResize) + bottomInset
    : 0;

  return {
    width,
    height,
    isLandscape,
    topInset: insets.top > 0 ? insets.top : statusBarFallback(isLandscape),
    bottomInset,
    keyboardVisible,
    keyboardOffset,
  };
}
