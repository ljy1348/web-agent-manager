package com.webagentmanager.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.Button;
import android.widget.FrameLayout;

// 설정 버튼의 가장자리 드래그·위치 저장·축소 탭 숨김과 복원을 관리한다.
public final class FloatingSettingsController {
    private static final String KEY_LEFT = "settings_button_left";
    private static final String KEY_Y_RATIO = "settings_button_y_ratio";
    private static final String KEY_COLLAPSED = "settings_button_collapsed";
    private final FrameLayout root;
    private final Button button;
    private final Button handle;
    private final SharedPreferences preferences;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int touchSlop;
    private float downRawX;
    private float downRawY;
    private float downX;
    private float downY;
    private boolean dragging;
    private boolean longPressed;

    // 루트 위에 설정 버튼과 숨김 복원 탭을 만들고 저장된 상태를 적용한다.
    public FloatingSettingsController(Context context, FrameLayout root, Runnable openSettings) {
        this.root = root;
        this.preferences = ServerConfig.preferences(context);
        this.touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        this.button = createButton(context, "⚙", 18f, getRoundedBackground(210, 31, 41, 55, dp(context, 22)));
        this.button.setContentDescription(context.getString(R.string.settings));
        this.button.setOnClickListener(view -> openSettings.run());
        this.button.setOnTouchListener(this::handleTouch);
        this.handle = createButton(context, "‹", 15f, getRoundedBackground(150, 31, 41, 55, dp(context, 8)));
        this.handle.setContentDescription(context.getString(R.string.restore_settings));
        this.handle.setOnClickListener(view -> expand());
        showCollapsed(preferences.getBoolean(KEY_COLLAPSED, false));
        root.addView(button, new FrameLayout.LayoutParams(dp(context, 44), dp(context, 44)));
        root.addView(handle, new FrameLayout.LayoutParams(dp(context, 16), dp(context, 48)));
        root.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (!dragging && (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop)) positionFromPreferences();
        });
        root.post(this::positionFromPreferences);
    }

    // 설정 대화상자의 명시적 숨기기 동작과 길게 누르기가 같은 축소 상태를 사용하게 한다.
    public void collapse() {
        snapAndSave();
        preferences.edit().putBoolean(KEY_COLLAPSED, true).apply();
        showCollapsed(true);
    }

    // 시스템 inset이나 화면 크기가 바뀌면 저장 위치를 새 안전 영역 안으로 다시 맞춘다.
    public void reposition() {
        root.post(this::positionFromPreferences);
    }

    // 작은 가장자리 탭을 설정 버튼으로 되돌리고 상태를 저장한다.
    private void expand() {
        preferences.edit().putBoolean(KEY_COLLAPSED, false).apply();
        showCollapsed(false);
        positionFromPreferences();
    }

    // 이동과 짧은 탭·길게 누르기를 충돌 없이 구분한다.
    private boolean handleTouch(View view, MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            downRawX = event.getRawX();
            downRawY = event.getRawY();
            downX = button.getX();
            downY = button.getY();
            dragging = false;
            longPressed = false;
            handler.postDelayed(this::triggerLongPress, ViewConfiguration.getLongPressTimeout());
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
            float deltaX = event.getRawX() - downRawX;
            float deltaY = event.getRawY() - downRawY;
            if (!dragging && Math.hypot(deltaX, deltaY) > touchSlop) {
                dragging = true;
                handler.removeCallbacksAndMessages(null);
            }
            if (dragging) setPosition(downX + deltaX, downY + deltaY);
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            handler.removeCallbacksAndMessages(null);
            if (longPressed) return true;
            if (dragging) snapAndSave();
            else view.performClick();
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            handler.removeCallbacksAndMessages(null);
            if (dragging) snapAndSave();
            return true;
        }
        return true;
    }

    // 움직이지 않은 채 길게 누른 경우 설정 버튼을 가장자리 복원 탭으로 접는다.
    private void triggerLongPress() {
        if (dragging) return;
        longPressed = true;
        collapse();
    }

    // 현재 좌우 위치를 가까운 가장자리로 붙이고 세로 비율을 회전 후에도 복원할 수 있게 저장한다.
    private void snapAndSave() {
        if (root.getWidth() <= 0 || button.getWidth() <= 0) return;
        boolean left = button.getX() + button.getWidth() / 2f < root.getWidth() / 2f;
        float minY = minimumY();
        float maxY = maximumY(button);
        float ratio = maxY <= minY ? 0f : (button.getY() - minY) / (maxY - minY);
        preferences.edit().putBoolean(KEY_LEFT, left).putFloat(KEY_Y_RATIO, clamp(ratio, 0f, 1f)).apply();
        positionFromPreferences();
    }

    // 저장된 가장자리·세로 비율을 현재 화면과 시스템 inset 안으로 다시 계산한다.
    private void positionFromPreferences() {
        if (root.getWidth() <= 0 || root.getHeight() <= 0) return;
        boolean left = preferences.getBoolean(KEY_LEFT, false);
        float ratio = preferences.getFloat(KEY_Y_RATIO, 0f);
        float minY = minimumY();
        float maxY = maximumY(button);
        float x = left ? root.getPaddingLeft() + dp(root.getContext(), 6) : root.getWidth() - root.getPaddingRight() - button.getWidth() - dp(root.getContext(), 6);
        setPosition(x, minY + clamp(ratio, 0f, 1f) * Math.max(0f, maxY - minY));
        handle.setText(left ? "›" : "‹");
        handle.setX(left ? root.getPaddingLeft() : root.getWidth() - root.getPaddingRight() - handle.getWidth());
        handle.setY(clamp(button.getY(), minimumY(), maximumY(handle)));
        showCollapsed(preferences.getBoolean(KEY_COLLAPSED, false));
    }

    // 드래그 중 버튼이 시스템 안전 영역 밖으로 나가지 않게 좌표를 제한한다.
    private void setPosition(float x, float y) {
        float minX = root.getPaddingLeft();
        float maxX = root.getWidth() - root.getPaddingRight() - button.getWidth();
        button.setX(clamp(x, minX, Math.max(minX, maxX)));
        button.setY(clamp(y, minimumY(), maximumY(button)));
    }

    // 시스템 상단 inset 아래의 버튼 최소 Y 좌표를 계산한다.
    private float minimumY() {
        return root.getPaddingTop() + dp(root.getContext(), 6);
    }

    // 시스템 하단 inset 위의 대상 뷰 최대 Y 좌표를 계산한다.
    private float maximumY(View view) {
        return Math.max(minimumY(), root.getHeight() - root.getPaddingBottom() - view.getHeight() - dp(root.getContext(), 6));
    }

    // 설정 버튼과 복원 탭 중 현재 상태에 맞는 하나만 화면에 표시한다.
    private void showCollapsed(boolean collapsed) {
        button.setVisibility(collapsed ? View.GONE : View.VISIBLE);
        handle.setVisibility(collapsed ? View.VISIBLE : View.GONE);
    }

    // 공통 색상·크기의 텍스트 버튼을 만든다.
    private static Button createButton(Context context, String text, float textSizeSp, GradientDrawable background) {
        Button target = new Button(context);
        target.setText(text);
        target.setTextSize(textSizeSp);
        target.setTextColor(Color.WHITE);
        target.setAllCaps(false);
        target.setPadding(0, 0, 0, 0);
        target.setBackground(background);
        return target;
    }

    // 반투명 네이비 배경을 지정한 둥근 사각형을 만든다.
    private static GradientDrawable getRoundedBackground(int alpha, int red, int green, int blue, float radius) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(alpha, red, green, blue));
        background.setCornerRadius(radius);
        return background;
    }

    // 값을 지정 범위로 제한한다.
    private static float clamp(float value, float minimum, float maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    // dp 단위를 현재 화면 픽셀로 변환한다.
    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
