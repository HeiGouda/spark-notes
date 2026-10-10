package com.spark.app

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretAccountArgs {
  lateinit var account: String
}

@InvokeArg
class UriArgs {
  lateinit var uri: String
}

@InvokeArg
class BarsArgs {
  var light: Boolean = true
}

@InvokeArg
class SelectionMenuArgs {
  var hidden: Boolean = false
}

@InvokeArg
class PageTurnConfigArgs {
  var enabled: Boolean = false
  var anim: String = "slide"
  var canPrev: Boolean = true
  var canNext: Boolean = true
  var footer: Double = 0.0
}

@InvokeArg
class PageTurnStartArgs {
  var dir: Int = 1
}

@InvokeArg
class PageTurnReadyArgs {
  var moved: Boolean = false
}

@InvokeArg
class SecretWriteArgs {
  lateinit var account: String
  lateinit var secret: String
}

/**
 * 密码用 AndroidKeyStore 里的 AES 密钥加密后存进应用私有的 SharedPreferences。
 * 密钥不能导出，卸载应用时和密文一起消失。
 */
@TauriPlugin
class SecretPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    return generator.generateKey()
  }

  @Command
  fun write(invoke: Invoke) {
    val args = invoke.parseArgs(SecretWriteArgs::class.java)
    try {
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val sealed = cipher.iv + cipher.doFinal(args.secret.toByteArray(Charsets.UTF_8))
      if (!prefs.edit().putString(args.account, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
        invoke.reject("写入存储失败")
        return
      }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  @Command
  fun read(invoke: Invoke) {
    val args = invoke.parseArgs(SecretAccountArgs::class.java)
    val result = JSObject()
    val stored = prefs.getString(args.account, null)
    if (stored == null) {
      invoke.resolve(result)
      return
    }
    try {
      val sealed = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
      result.put("secret", String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8))
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  @Command
  fun remove(invoke: Invoke) {
    val args = invoke.parseArgs(SecretAccountArgs::class.java)
    if (!prefs.edit().remove(args.account).commit()) {
      invoke.reject("写入存储失败")
      return
    }
    invoke.resolve()
  }

  /** 当前网络按流量计费（通常是移动数据） */
  @Command
  fun isMetered(invoke: Invoke) {
    val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val result = JSObject()
    result.put("metered", manager.isActiveNetworkMetered)
    invoke.resolve(result)
  }

  /**
   * 系统文件选择器给的是 content:// 地址，Rust 不能直接按路径读。
   * 拷到应用缓存目录里再交给 Rust，文件名用选择器里显示的名字。拷贝放在后台线程，大文件不卡界面。
   */
  @Command
  fun copyToCache(invoke: Invoke) {
    val args = invoke.parseArgs(UriArgs::class.java)
    Thread {
      try {
        val uri = Uri.parse(args.uri)
        val resolver = activity.contentResolver
        var shown: String? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) shown = cursor.getString(0)
        }
        val name = (shown ?: uri.lastPathSegment ?: "book").substringAfterLast('/').replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val dir = File(File(activity.cacheDir, "import"), System.nanoTime().toString()).apply { mkdirs() }
        val dest = File(dir, name)
        val input = resolver.openInputStream(uri) ?: throw IllegalStateException("打不开这个文件")
        input.use { source -> dest.outputStream().use { source.copyTo(it) } }
        val result = JSObject()
        result.put("path", dest.absolutePath)
        result.put("name", name)
        invoke.resolve(result)
      } catch (e: Exception) {
        invoke.reject("读取所选文件失败：${e.message ?: e}")
      }
    }.start()
  }

  /** 状态栏、导航栏的图标颜色：浅色背景用深色图标，深色背景用浅色图标 */
  @Command
  fun setSystemBars(invoke: Invoke) {
    val args = invoke.parseArgs(BarsArgs::class.java)
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.isAppearanceLightStatusBars = args.light
      controller.isAppearanceLightNavigationBars = args.light
    }
    invoke.resolve()
  }

  /** 阅读页选字时只用 App 自己的菜单，不显示系统的复制、分享工具条（见 MainActivity） */
  @Command
  fun setSelectionMenu(invoke: Invoke) {
    val args = invoke.parseArgs(SelectionMenuArgs::class.java)
    hideSelectionMenu = args.hidden
    invoke.resolve()
  }

  /** 阅读页翻页动画（见 PageTurn）：滑动翻页开关、动画种类、两头还能不能翻 */
  @Command
  fun pageTurnConfig(invoke: Invoke) {
    val args = invoke.parseArgs(PageTurnConfigArgs::class.java)
    activity.runOnUiThread {
      PageTurn.configure(args.enabled, args.anim, args.canPrev, args.canNext, args.footer.toFloat())
      invoke.resolve()
    }
  }

  /** 点两侧翻页：盖上当前画面的截图后返回 started，网页再换页 */
  @Command
  fun pageTurnStart(invoke: Invoke) {
    val args = invoke.parseArgs(PageTurnStartArgs::class.java)
    activity.runOnUiThread {
      PageTurn.start(if (args.dir < 0) -1 else 1) { started ->
        val result = JSObject()
        result.put("started", started)
        invoke.resolve(result)
      }
    }
  }

  /** 网页换好页了，开始动画 */
  @Command
  fun pageTurnReady(invoke: Invoke) {
    val args = invoke.parseArgs(PageTurnReadyArgs::class.java)
    activity.runOnUiThread {
      PageTurn.ready(args.moved)
      invoke.resolve()
    }
  }

  /** 书页停稳了，趁空闲先截好前后两页 */
  @Command
  fun pageTurnPrefetch(invoke: Invoke) {
    activity.runOnUiThread {
      PageTurn.prefetch()
      invoke.resolve()
    }
  }

  /** 离开阅读页 */
  @Command
  fun pageTurnStop(invoke: Invoke) {
    activity.runOnUiThread {
      PageTurn.stop()
      invoke.resolve()
    }
  }

  /** 首页连按两次返回：和系统默认一样把应用退到后台，回到桌面 */
  @Command
  fun moveToBack(invoke: Invoke) {
    activity.runOnUiThread { activity.moveTaskToBack(true) }
    invoke.resolve()
  }

  companion object {
    @Volatile
    var hideSelectionMenu = false
    private const val PREFS = "spark_secrets"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "spark-secrets"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
  }
}
