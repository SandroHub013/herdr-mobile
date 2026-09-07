import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';

const VISIBLE_MS = 3500;

/**
 * Failed commands used to disappear into empty catch blocks. Now they say so.
 */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((text: string) => {
    setMessage(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setMessage(null), VISIBLE_MS);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { message, show };
}

export function Toast({ message, top }: { message: string | null; top: number }) {
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.container, { top }]}>
      <View style={styles.toast}>
        <Text style={styles.text} numberOfLines={2}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  toast: {
    maxWidth: 460,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceActive,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: {
    ...type.caption,
    color: colors.text,
    textAlign: 'center',
  },
});
