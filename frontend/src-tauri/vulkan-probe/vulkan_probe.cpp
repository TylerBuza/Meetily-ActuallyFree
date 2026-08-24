#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <vector>

namespace {

enum ExitCode : int {
  kAvailable = 0,
  kLoaderUnavailable = 10,
  kEntryPointUnavailable = 11,
  kInstanceUnavailable = 12,
  kNoCompatibleDevice = 13,
  kEnumerationFailed = 14,
};

template <typename T>
T LoadInstanceFunction(PFN_vkGetInstanceProcAddr get_instance_proc_addr,
                       VkInstance instance, const char* name) {
  return reinterpret_cast<T>(get_instance_proc_addr(instance, name));
}

struct VulkanFunctions {
  PFN_vkDestroyDevice destroy_device;
  PFN_vkGetPhysicalDeviceProperties get_physical_device_properties;
  PFN_vkGetPhysicalDeviceQueueFamilyProperties
      get_physical_device_queue_family_properties;
  PFN_vkGetPhysicalDeviceFeatures2 get_physical_device_features2;
  PFN_vkEnumerateDeviceExtensionProperties
      enumerate_device_extension_properties;
  PFN_vkCreateDevice create_device;
};

bool HasRequiredExtension(VkPhysicalDevice physical_device,
                          const VulkanFunctions& functions) {
  std::uint32_t extension_count = 0;
  if (functions.enumerate_device_extension_properties(
          physical_device, nullptr, &extension_count, nullptr) != VK_SUCCESS ||
      extension_count == 0) {
    return false;
  }

  std::vector<VkExtensionProperties> extensions(extension_count);
  if (functions.enumerate_device_extension_properties(
          physical_device, nullptr, &extension_count, extensions.data()) !=
      VK_SUCCESS) {
    return false;
  }
  for (const auto& extension : extensions) {
    if (std::strcmp(extension.extensionName,
                    VK_KHR_16BIT_STORAGE_EXTENSION_NAME) == 0) {
      return true;
    }
  }
  return false;
}

bool TryCreateCompatibleDevice(VkPhysicalDevice physical_device,
                               const VulkanFunctions& functions) {
  VkPhysicalDeviceProperties properties{};
  functions.get_physical_device_properties(physical_device, &properties);
  if (properties.apiVersion < VK_API_VERSION_1_2 ||
      properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU) {
    return false;
  }

  std::uint32_t queue_family_count = 0;
  functions.get_physical_device_queue_family_properties(
      physical_device, &queue_family_count, nullptr);
  if (queue_family_count == 0) {
    return false;
  }
  std::vector<VkQueueFamilyProperties> queue_families(queue_family_count);
  functions.get_physical_device_queue_family_properties(
      physical_device, &queue_family_count, queue_families.data());

  std::uint32_t compute_queue_family = queue_family_count;
  for (std::uint32_t index = 0; index < queue_family_count; ++index) {
    if (queue_families[index].queueCount > 0 &&
        (queue_families[index].queueFlags & VK_QUEUE_COMPUTE_BIT) != 0) {
      compute_queue_family = index;
      break;
    }
  }
  if (compute_queue_family == queue_family_count ||
      !HasRequiredExtension(physical_device, functions)) {
    return false;
  }

  VkPhysicalDeviceVulkan12Features vulkan12_features{};
  vulkan12_features.sType =
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES;
  VkPhysicalDeviceVulkan11Features vulkan11_features{};
  vulkan11_features.sType =
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES;
  vulkan11_features.pNext = &vulkan12_features;
  VkPhysicalDeviceFeatures2 device_features{};
  device_features.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
  device_features.pNext = &vulkan11_features;
  functions.get_physical_device_features2(physical_device, &device_features);
  if (vulkan11_features.storageBuffer16BitAccess != VK_TRUE) {
    return false;
  }

  const float queue_priority = 1.0f;
  VkDeviceQueueCreateInfo queue_create_info{};
  queue_create_info.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
  queue_create_info.queueFamilyIndex = compute_queue_family;
  queue_create_info.queueCount = 1;
  queue_create_info.pQueuePriorities = &queue_priority;

  const char* required_extensions[] = {
      VK_KHR_16BIT_STORAGE_EXTENSION_NAME,
  };
  VkDeviceCreateInfo device_create_info{};
  device_create_info.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
  device_create_info.pNext = &device_features;
  device_create_info.queueCreateInfoCount = 1;
  device_create_info.pQueueCreateInfos = &queue_create_info;
  device_create_info.enabledExtensionCount = 1;
  device_create_info.ppEnabledExtensionNames = required_extensions;

  VkDevice device = VK_NULL_HANDLE;
  if (functions.create_device(physical_device, &device_create_info, nullptr,
                              &device) != VK_SUCCESS ||
      device == VK_NULL_HANDLE) {
    return false;
  }

  functions.destroy_device(device, nullptr);
  return true;
}

}  // namespace

int main() {
  HMODULE loader = LoadLibraryExW(L"vulkan-1.dll", nullptr,
                                  LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (loader == nullptr) {
    std::fputs("Vulkan system loader is unavailable.\n", stderr);
    return kLoaderUnavailable;
  }

  const auto get_instance_proc_addr =
      reinterpret_cast<PFN_vkGetInstanceProcAddr>(
          GetProcAddress(loader, "vkGetInstanceProcAddr"));
  if (get_instance_proc_addr == nullptr) {
    std::fputs("Vulkan loader entry point is unavailable.\n", stderr);
    FreeLibrary(loader);
    return kEntryPointUnavailable;
  }

  const auto create_instance = LoadInstanceFunction<PFN_vkCreateInstance>(
      get_instance_proc_addr, VK_NULL_HANDLE, "vkCreateInstance");
  if (create_instance == nullptr) {
    std::fputs("Vulkan instance entry point is unavailable.\n", stderr);
    FreeLibrary(loader);
    return kEntryPointUnavailable;
  }

  const VkApplicationInfo application_info{
      VK_STRUCTURE_TYPE_APPLICATION_INFO,
      nullptr,
      "Meetily Vulkan Probe",
      1,
      nullptr,
      0,
      VK_API_VERSION_1_2,
  };
  const VkInstanceCreateInfo create_info{
      VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
      nullptr,
      0,
      &application_info,
      0,
      nullptr,
      0,
      nullptr,
  };

  VkInstance instance = VK_NULL_HANDLE;
  const VkResult create_result =
      create_instance(&create_info, nullptr, &instance);
  if (create_result != VK_SUCCESS || instance == VK_NULL_HANDLE) {
    std::fprintf(stderr, "Vulkan instance creation failed (%d).\n",
                 static_cast<int>(create_result));
    FreeLibrary(loader);
    return kInstanceUnavailable;
  }

  const auto enumerate_physical_devices =
      LoadInstanceFunction<PFN_vkEnumeratePhysicalDevices>(
          get_instance_proc_addr, instance, "vkEnumeratePhysicalDevices");
  const auto destroy_instance = LoadInstanceFunction<PFN_vkDestroyInstance>(
      get_instance_proc_addr, instance, "vkDestroyInstance");
  const VulkanFunctions functions{
      LoadInstanceFunction<PFN_vkDestroyDevice>(get_instance_proc_addr, instance,
                                                "vkDestroyDevice"),
      LoadInstanceFunction<PFN_vkGetPhysicalDeviceProperties>(
          get_instance_proc_addr, instance, "vkGetPhysicalDeviceProperties"),
      LoadInstanceFunction<PFN_vkGetPhysicalDeviceQueueFamilyProperties>(
          get_instance_proc_addr, instance,
          "vkGetPhysicalDeviceQueueFamilyProperties"),
      LoadInstanceFunction<PFN_vkGetPhysicalDeviceFeatures2>(
          get_instance_proc_addr, instance, "vkGetPhysicalDeviceFeatures2"),
      LoadInstanceFunction<PFN_vkEnumerateDeviceExtensionProperties>(
          get_instance_proc_addr, instance,
          "vkEnumerateDeviceExtensionProperties"),
      LoadInstanceFunction<PFN_vkCreateDevice>(get_instance_proc_addr, instance,
                                               "vkCreateDevice"),
  };
  if (enumerate_physical_devices == nullptr || destroy_instance == nullptr ||
      functions.destroy_device == nullptr ||
      functions.get_physical_device_properties == nullptr ||
      functions.get_physical_device_queue_family_properties == nullptr ||
      functions.get_physical_device_features2 == nullptr ||
      functions.enumerate_device_extension_properties == nullptr ||
      functions.create_device == nullptr) {
    std::fputs("Required Vulkan instance entry point is unavailable.\n",
               stderr);
    if (destroy_instance != nullptr) {
      destroy_instance(instance, nullptr);
    }
    FreeLibrary(loader);
    return kEntryPointUnavailable;
  }

  std::uint32_t physical_device_count = 0;
  VkResult enumerate_result =
      enumerate_physical_devices(instance, &physical_device_count, nullptr);
  if (enumerate_result != VK_SUCCESS) {
    std::fprintf(stderr, "Vulkan device enumeration failed (%d).\n",
                 static_cast<int>(enumerate_result));
    destroy_instance(instance, nullptr);
    FreeLibrary(loader);
    return kEnumerationFailed;
  }
  if (physical_device_count == 0) {
    std::fputs("No Vulkan physical device is available.\n", stderr);
    destroy_instance(instance, nullptr);
    FreeLibrary(loader);
    return kNoCompatibleDevice;
  }

  std::vector<VkPhysicalDevice> physical_devices(physical_device_count);
  enumerate_result = enumerate_physical_devices(
      instance, &physical_device_count, physical_devices.data());
  if (enumerate_result != VK_SUCCESS) {
    std::fprintf(stderr, "Vulkan device enumeration failed (%d).\n",
                 static_cast<int>(enumerate_result));
    destroy_instance(instance, nullptr);
    FreeLibrary(loader);
    return kEnumerationFailed;
  }

  std::vector<VkPhysicalDevice> selected_devices;
  for (const VkPhysicalDevice physical_device : physical_devices) {
    VkPhysicalDeviceProperties properties{};
    functions.get_physical_device_properties(physical_device, &properties);
    if (properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
      selected_devices.push_back(physical_device);
    }
  }
  if (selected_devices.empty()) {
    selected_devices.push_back(physical_devices.front());
  }

  bool selected_devices_compatible = true;
  for (const VkPhysicalDevice physical_device : selected_devices) {
    if (!TryCreateCompatibleDevice(physical_device, functions)) {
      selected_devices_compatible = false;
      break;
    }
  }
  destroy_instance(instance, nullptr);
  FreeLibrary(loader);

  if (!selected_devices_compatible) {
    std::fputs("Meetily's selected Vulkan device is not compatible.\n",
               stderr);
    return kNoCompatibleDevice;
  }

  std::printf("Validated %zu Vulkan device(s) selected by Meetily.\n",
              selected_devices.size());
  return kAvailable;
}
