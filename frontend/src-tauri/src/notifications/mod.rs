// Notification system module
pub mod types;
pub mod system;
pub mod settings;
pub mod commands;
pub mod manager;

// Windows-only: native toasts that appear as "Meetily - Actually Free" instead
// of "Windows PowerShell" (see native_windows.rs for the full explanation).
#[cfg(windows)]
pub mod native_windows;

// Re-export main types for easy access
pub use types::{
    Notification, NotificationType, NotificationPriority, NotificationTimeout
};
pub use settings::{
    NotificationSettings, ConsentManager, get_default_settings
};
pub use manager::NotificationManager;
pub use system::SystemNotificationHandler;

// Export commands for Tauri
pub use commands::{
    get_notification_settings,
    set_notification_settings,
    request_notification_permission,
    show_notification,
    show_test_notification,
    is_dnd_active,
    get_system_dnd_status,
};