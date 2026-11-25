package com.genymobile.scrcpy;

import com.genymobile.scrcpy.device.Device;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;
import android.os.UserHandle;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;

/** Short-lived package metadata reader for the desktop applications panel. */
public final class WorkspaceApps {
    private WorkspaceApps() {
    }

    private static PackageManager packageManager(int userId) throws ReflectiveOperationException {
        if (userId == 0) {
            return FakeContext.get().getPackageManager();
        }
        // Context#createPackageContextAsUser and UserHandle#of are system APIs.
        UserHandle user = (UserHandle) UserHandle.class.getMethod("of", int.class).invoke(null, userId);
        Context context = (Context) Context.class.getMethod("createPackageContextAsUser", String.class, int.class, UserHandle.class)
                .invoke(FakeContext.get().getBaseContext(), FakeContext.PACKAGE_NAME, 0, user);
        return context.getPackageManager();
    }

    private static String thumbnail(Drawable icon) {
        int size = 72;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        try {
            int width = icon.getIntrinsicWidth();
            int height = icon.getIntrinsicHeight();
            if (width < 1 || height < 1) {
                width = size;
                height = size;
            }
            float scale = (float) size / Math.max(width, height);
            int w = Math.max(1, Math.round(width * scale));
            int h = Math.max(1, Math.round(height * scale));
            int x = (size - w) / 2;
            int y = (size - h) / 2;
            icon.setBounds(x, y, x + w, y + h);
            icon.draw(new Canvas(bitmap));
            ByteArrayOutputStream image = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, image);
            return Base64.encodeToString(image.toByteArray(), Base64.NO_WRAP);
        } finally {
            bitmap.recycle();
        }
    }

    private static JSONObject info(PackageManager pm, String name) throws Exception {
        PackageInfo pkg = pm.getPackageInfo(name, 0);
        ApplicationInfo app = pkg.applicationInfo;
        JSONObject result = new JSONObject();
        result.put("bundleName", pkg.packageName);
        result.put("system", (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
        result.put("apiTargetVersion", app.targetSdkVersion);
        result.put("installTime", pkg.firstInstallTime);
        result.put("versionName", pkg.versionName);
        try {
            result.put("label", app.loadLabel(pm).toString());
            result.put("png", thumbnail(app.loadIcon(pm)));
        } catch (RuntimeException ignored) {
            // A missing or malformed app resource does not invalidate package metadata.
        }
        Intent launcher = Device.getLaunchIntent(pm, name);
        if (launcher != null && launcher.getComponent() != null) {
            result.put("mainAbility", launcher.getComponent().flattenToShortString());
        }
        return result;
    }

    public static void main(String... args) {
        int status = 0;
        try {
            Looper.prepareMainLooper();
            Workarounds.apply();
            PackageManager pm = packageManager(Integer.parseInt(args[0]));
            JSONArray apps = new JSONArray();
            for (int i = 1; i < args.length; ++i) {
                try {
                    apps.put(info(pm, args[i]));
                } catch (PackageManager.NameNotFoundException ignored) {
                    // The package was removed after enumeration.
                }
            }
            PrintStream output = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
            output.println("SCRCPY_WORKSPACE_APPS " + apps);
        } catch (Throwable failure) {
            status = 1;
        } finally {
            System.exit(status);
        }
    }
}
