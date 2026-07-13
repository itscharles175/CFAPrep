import { useId } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import {
  getTimerDefaults,
  setTimerDefaults,
} from "@lsat/lib/prefs";
import { toast } from "@lsat/lib/toast";

const schema = z.object({
  lrMin: z.number().min(20).max(60),
  rcMin: z.number().min(20).max(60),
});

type FormValues = z.infer<typeof schema>;

export function TimerSettingsForm() {
  const initial = getTimerDefaults();
  const lrId = useId();
  const rcId = useId();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initial,
  });

  function onSubmit(values: FormValues) {
    setTimerDefaults({ lrMin: values.lrMin, rcMin: values.rcMin });
    toast.success("Timer defaults saved");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid grid-cols-2 gap-4">
      <div className="space-y-1.5">
        <Label htmlFor={lrId}>LR section (minutes)</Label>
        <Input
          id={lrId}
          type="number"
          {...register("lrMin", { valueAsNumber: true })}
        />
        {errors.lrMin && (
          <p className="text-xs text-destructive">{errors.lrMin.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={rcId}>RC section (minutes)</Label>
        <Input
          id={rcId}
          type="number"
          {...register("rcMin", { valueAsNumber: true })}
        />
        {errors.rcMin && (
          <p className="text-xs text-destructive">{errors.rcMin.message}</p>
        )}
      </div>
      <Button type="submit" size="sm" className="col-span-2 w-fit">
        Save timer defaults
      </Button>
    </form>
  );
}
