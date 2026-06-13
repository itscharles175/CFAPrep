import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  name: z
    .string()
    .min(1, "PrepTest name is required")
    .max(120, "Name must be 120 characters or fewer"),
});

type FormValues = z.infer<typeof schema>;

export function ImportNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}) {
  const {
    register,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: value },
    mode: "onChange",
  });

  useEffect(() => {
    reset({ name: value });
  }, [value, reset]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="import-preptest-name">PrepTest name</Label>
      <Input
        id="import-preptest-name"
        {...register("name", {
          onChange: (e) => onChange(e.target.value),
        })}
      />
      {errors.name && (
        <p className="text-xs text-destructive">{errors.name.message}</p>
      )}
    </div>
  );
}

export function isImportNameValid(name: string): boolean {
  return schema.safeParse({ name }).success;
}
