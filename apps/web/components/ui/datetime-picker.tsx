"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";

/**
 * Drop-in replacement for <input type="datetime-local">.
 *
 * Contract MATCHES the native input it replaces so call sites need no other
 * changes:
 *   - `value`    : a naive LOCAL datetime string "YYYY-MM-DDTHH:mm" (or "")
 *   - `onChange` : called with the same "YYYY-MM-DDTHH:mm" string
 *   - `min`      : optional lower bound, same "YYYY-MM-DDTHH:mm" format
 *
 * IMPORTANT: we never call Date.toISOString() on the value — that converts to
 * UTC and would silently shift every scheduled post by the user's timezone
 * offset. All parsing/formatting is done on local components by hand.
 */

interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:mm" -> {date: Date|null, hour, minute} (all local). */
function parseLocal(value: string): { date: Date | null; hour: number; minute: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return { date: null, hour: 0, minute: 0 };
  const [, y, mo, d, h, mi] = m;
  return {
    date: new Date(Number(y), Number(mo) - 1, Number(d)),
    hour: Number(h),
    minute: Number(mi),
  };
}

/** Build "YYYY-MM-DDTHH:mm" from a local Date + hour/minute. */
function formatLocal(date: Date, hour: number, minute: number): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}`;
}

/** Human-readable label for the trigger button. */
function displayLabel(value: string): string {
  const { date, hour, minute } = parseLocal(value);
  if (!date) return "";
  const dateStr = date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `${dateStr}, ${pad(hour)}:${pad(minute)}`;
}

export function DateTimePicker({
  value,
  onChange,
  min,
  id,
  className,
  placeholder = "Pick date & time",
  disabled,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false);
  const { date, hour, minute } = parseLocal(value);

  const minParsed = min ? parseLocal(min) : null;
  const minDate = minParsed?.date ?? undefined;

  const emit = (nextDate: Date | null, nextHour: number, nextMinute: number) => {
    if (!nextDate) return;
    onChange(formatLocal(nextDate, nextHour, nextMinute));
  };

  const handleDateSelect = (selected: Date | undefined) => {
    if (!selected) return;
    // Keep the existing time when only the date changes; default to next round
    // hour if no time chosen yet.
    const now = new Date();
    const h = date ? hour : now.getHours();
    const mi = date ? minute : 0;
    emit(selected, h, mi);
  };

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 60 }, (_, i) => i);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 size-4" />
          {value ? displayLabel(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          <Calendar
            mode="single"
            selected={date ?? undefined}
            onSelect={handleDateSelect}
            month={date ?? undefined}
            disabled={minDate ? { before: minDate } : undefined}
            autoFocus
          />
          <div className="flex border-l">
            {/* Hours */}
            <ScrollArea className="h-[280px] w-14">
              <div className="flex flex-col p-1">
                {hours.map((h) => (
                  <Button
                    key={h}
                    type="button"
                    size="sm"
                    variant={date && hour === h ? "default" : "ghost"}
                    className="mb-1 shrink-0"
                    onClick={() => emit(date ?? new Date(), h, minute)}
                  >
                    {pad(h)}
                  </Button>
                ))}
              </div>
            </ScrollArea>
            {/* Minutes */}
            <ScrollArea className="h-[280px] w-14 border-l">
              <div className="flex flex-col p-1">
                {minutes.map((mi) => (
                  <Button
                    key={mi}
                    type="button"
                    size="sm"
                    variant={date && minute === mi ? "default" : "ghost"}
                    className="mb-1 shrink-0"
                    onClick={() => emit(date ?? new Date(), hour, mi)}
                  >
                    {pad(mi)}
                  </Button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}