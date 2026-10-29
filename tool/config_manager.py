import json
import os
import tkinter as tk
from tkinter import colorchooser, messagebox, ttk

# Comme l'outil est dans le dossier 'tools', on remonte d'un cran (..) pour accéder au dossier 'json'
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "json", "repos-config.json")


class ConfigManagerApp:

  def __init__(self, root):
    self.root = root
    self.root.title("Gestionnaire de Config - PS5 Repos Hub")
    self.root.geometry("850x600")
    self.root.minsize(700, 500)

    # Données en mémoire
    self.data = {"categories": [], "repos": []}

    self.load_config()

    # --- INTERFACE GRAPHIQUE ---
    self.create_widgets()

  def load_config(self):
    """Charge le fichier JSON de configuration s'il existe."""
    if os.path.exists(CONFIG_PATH):
      try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
          self.data = json.load(f)
      except Exception as e:
        messagebox.showerror(
            "Erreur", f"Impossible de lire le fichier de config :\n{e}"
        )
    if "categories" not in self.data:
      self.data["categories"] = []
    if "repos" not in self.data:
      self.data["repos"] = []

  def save_config(self):
    """Sauvegarde les données dans le fichier JSON."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    try:
      with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(self.data, f, indent=2, ensure_ascii=False)
      # CORRECTION : Remplacement de messagebox.succès par messagebox.showinfo
      messagebox.showinfo(
          "Succès", f"Configuration enregistrée avec succès dans {CONFIG_PATH} !"
      )
    except Exception as e:
      messagebox.showerror("Erreur", f"Impossible d'enregistrer :\n{e}")

  def create_widgets(self):
    # Utilisation d'un Notebook (Onglets)
    notebook = ttk.Notebook(self.root)
    notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

    # --- ONGLET 1 : DÉPÔTS (REPOS) ---
    self.tab_repos = ttk.Frame(notebook)
    notebook.add(self.tab_repos, text=" Dépôts GitHub ")
    self.setup_repos_tab()

    # --- ONGLET 2 : CATÉGORIES ---
    self.tab_cats = ttk.Frame(notebook)
    notebook.add(self.tab_cats, text=" Catégories & Couleurs ")
    self.setup_cats_tab()

    # Bouton global de sauvegarde en bas
    btn_save = tk.Button(
        self.root,
        text="Enregistrer tout dans le fichier JSON",
        bg="#22c55e",
        fg="white",
        font=("Arial", 11, "bold"),
        command=self.save_config,
    )
    btn_save.pack(fill=tk.X, padx=10, pady=10)

  def setup_repos_tab(self):
    form_frame = ttk.LabelFrame(
        self.tab_repos, text=" Ajouter / Modifier un dépôt "
    )
    form_frame.pack(fill=tk.X, padx=10, pady=10)

    tk.Label(form_frame, text="URL GitHub du dépôt:").grid(
        row=0, column=0, sticky="w", padx=5, pady=5
    )
    self.repo_url_entry = tk.Entry(
        form_frame, width=50, font=("Arial", 10)
    )
    self.repo_url_entry.grid(row=0, column=1, padx=5, pady=5)

    tk.Label(form_frame, text="Catégorie:").grid(
        row=1, column=0, sticky="w", padx=5, pady=5
    )
    self.repo_cat_combo = ttk.Combobox(
        form_frame, state="readonly", width=47
    )
    self.repo_cat_combo.grid(row=1, column=1, padx=5, pady=5)
    self.update_category_dropdowns()

    btn_frame = tk.Frame(form_frame)
    btn_frame.grid(row=2, column=0, columnspan=2, pady=8)

    tk.Button(
        btn_frame,
        text="Ajouter le dépôt",
        bg="#3b82f6",
        fg="white",
        command=self.add_repo,
    ).pack(side=tk.LEFT, padx=5)
    tk.Button(
        btn_frame,
        text="Modifier la sélection",
        bg="#f59e0b",
        fg="white",
        command=self.update_repo,
    ).pack(side=tk.LEFT, padx=5)
    tk.Button(
        btn_frame, text="Vider les champs", command=self.clear_repo_form
    ).pack(side=tk.LEFT, padx=5)

    tree_frame = ttk.Frame(self.tab_repos)
    tree_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

    self.repo_tree = ttk.Treeview(
        tree_frame, columns=("url", "category"), show="headings", height=12
    )
    self.repo_tree.heading("url", text="URL GitHub du Dépôt")
    self.repo_tree.heading("category", text="ID Catégorie")
    self.repo_tree.column("url", width=500)
    self.repo_tree.column("category", width=200)

    scrollbar = ttk.Scrollbar(
        tree_frame, orient=tk.VERTICAL, command=self.repo_tree.yview
    )
    self.repo_tree.configure(yscrollcommand=scrollbar.set)

    self.repo_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

    self.repo_tree.bind("<<TreeviewSelect>>", self.on_repo_select)

    action_frame = tk.Frame(self.tab_repos)
    action_frame.pack(fill=tk.X, padx=10, pady=5)
    tk.Button(
        action_frame,
        text="Supprimer la sélection",
        bg="#ef4444",
        fg="white",
        command=self.delete_repo,
    ).pack(side=tk.LEFT)

    self.refresh_repo_list()

  def setup_cats_tab(self):
    form_frame = ttk.LabelFrame(
        self.tab_cats, text=" Ajouter / Modifier une catégorie "
    )
    form_frame.pack(fill=tk.X, padx=10, pady=10)

    tk.Label(form_frame, text="ID Unique (ex: cat-emulator):").grid(
        row=0, column=0, sticky="w", padx=5, pady=5
    )
    self.cat_id_entry = tk.Entry(form_frame, width=30, font=("Arial", 10))
    self.cat_id_entry.grid(row=0, column=1, padx=5, pady=5)

    tk.Label(form_frame, text="Nom d'affichage:").grid(
        row=1, column=0, sticky="w", padx=5, pady=5
    )
    self.cat_name_entry = tk.Entry(form_frame, width=30, font=("Arial", 10))
    self.cat_name_entry.grid(row=1, column=1, padx=5, pady=5)

    tk.Label(form_frame, text="Couleur (Hex):").grid(
        row=2, column=0, sticky="w", padx=5, pady=5
    )
    color_frame = tk.Frame(form_frame)
    color_frame.grid(row=2, column=1, sticky="w", padx=5, pady=5)

    self.cat_color_entry = tk.Entry(color_frame, width=15, font=("Arial", 10))
    self.cat_color_entry.pack(side=tk.LEFT, padx=(0, 5))
    self.cat_color_entry.insert(0, "#3B82F6")

    tk.Button(
        color_frame, text="Choisir...", command=self.pick_color
    ).pack(side=tk.LEFT)

    btn_frame = tk.Frame(form_frame)
    btn_frame.grid(row=3, column=0, columnspan=2, pady=8)

    tk.Button(
        btn_frame,
        text="Ajouter Catégorie",
        bg="#3b82f6",
        fg="white",
        command=self.add_category,
    ).pack(side=tk.LEFT, padx=5)
    tk.Button(
        btn_frame,
        text="Modifier Catégorie",
        bg="#f59e0b",
        fg="white",
        command=self.update_category,
    ).pack(side=tk.LEFT, padx=5)
    tk.Button(
        btn_frame, text="Vider", command=self.clear_cat_form
    ).pack(side=tk.LEFT, padx=5)

    tree_frame = ttk.Frame(self.tab_cats)
    tree_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

    self.cat_tree = ttk.Treeview(
        tree_frame, columns=("id", "name", "color"), show="headings", height=8
    )
    self.cat_tree.heading("id", text="ID")
    self.cat_tree.heading("name", text="Nom")
    self.cat_tree.heading("color", text="Couleur")
    self.cat_tree.column("id", width=200)
    self.cat_tree.column("name", width=300)
    self.cat_tree.column("color", width=150)

    self.cat_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
    self.cat_tree.bind("<<TreeviewSelect>>", self.on_cat_select)

    action_frame = tk.Frame(self.tab_cats)
    action_frame.pack(fill=tk.X, padx=10, pady=5)
    tk.Button(
        action_frame,
        text="Supprimer la catégorie",
        bg="#ef4444",
        fg="white",
        command=self.delete_category,
    ).pack(side=tk.LEFT)

    self.refresh_cat_list()

  def pick_color(self):
    color = colorchooser.askcolor(title="Choisir une couleur")
    if color[1]:
      self.cat_color_entry.delete(0, tk.END)
      self.cat_color_entry.insert(0, color[1])

  def refresh_cat_list(self):
    for row in self.cat_tree.get_children():
      self.cat_tree.delete(row)
    for cat in self.data["categories"]:
      self.cat_tree.insert(
          "",
          tk.END,
          values=(
              cat.get("id"),
              cat.get("name"),
              cat.get("color", "#3B82F6"),
          ),
      )
    self.update_category_dropdowns()

  def update_category_dropdowns(self):
    cat_ids = [cat["id"] for cat in self.data["categories"]]
    self.repo_cat_combo["values"] = cat_ids
    if cat_ids and not self.repo_cat_combo.get():
      self.repo_cat_combo.current(0)

  def add_category(self):
    cid = self.cat_id_entry.get().strip()
    cname = self.cat_name_entry.get().strip()
    ccolor = self.cat_color_entry.get().strip()

    if not cid or not cname:
      messagebox.showwarning(
          "Attention", "L'ID et le Nom de la catégorie sont obligatoires."
      )
      return

    if any(c["id"] == cid for c in self.data["categories"]):
      messagebox.showerror("Erreur", f"Une catégorie avec l'ID '{cid}' existe déjà.")
      return

    self.data["categories"].append(
        {"id": cid, "name": cname, "color": ccolor, "parentId": None}
    )
    self.refresh_cat_list()
    self.clear_cat_form()

  def update_category(self):
    selected = self.cat_tree.selection()
    if not selected:
      messagebox.showwarning("Attention", "Sélectionnez une catégorie à modifier.")
      return
    item = self.cat_tree.item(selected)
    old_id = item["values"][0]

    cid = self.cat_id_entry.get().strip()
    cname = self.cat_name_entry.get().strip()
    ccolor = self.cat_color_entry.get().strip()

    for cat in self.data["categories"]:
      if cat["id"] == old_id:
        cat["id"] = cid
        cat["name"] = cname
        cat["color"] = ccolor
        break

    self.refresh_cat_list()

  def delete_category(self):
    selected = self.cat_tree.selection()
    if not selected:
      messagebox.showwarning("Attention", "Sélectionnez une catégorie à supprimer.")
      return
    item = self.cat_tree.item(selected)
    cid = item["values"][0]

    if messagebox.askyesno(
        "Confirmation", f"Voulez-vous vraiment supprimer la catégorie '{cid}' ?"
    ):
      self.data["categories"] = [
          c for c in self.data["categories"] if c["id"] != cid
      ]
      self.refresh_cat_list()

  def on_cat_select(self, event):
    selected = self.cat_tree.selection()
    if selected:
      item = self.cat_tree.item(selected)
      values = item["values"]
      self.cat_id_entry.delete(0, tk.END)
      self.cat_id_entry.insert(0, values[0])
      self.cat_name_entry.delete(0, tk.END)
      self.cat_name_entry.insert(0, values[1])
      self.cat_color_entry.delete(0, tk.END)
      self.cat_color_entry.insert(0, values[2])

  def clear_cat_form(self):
    self.cat_id_entry.delete(0, tk.END)
    self.cat_name_entry.delete(0, tk.END)
    self.cat_color_entry.delete(0, tk.END)
    self.cat_color_entry.insert(0, "#3B82F6")

  def refresh_repo_list(self):
    for row in self.repo_tree.get_children():
      self.repo_tree.delete(row)
    for repo in self.data["repos"]:
      self.repo_tree.insert(
          "", tk.END, values=(repo.get("url"), repo.get("categoryId"))
      )

  def add_repo(self):
    url = self.repo_url_entry.get().strip()
    cat_id = self.repo_cat_combo.get().strip()

    if not url or "github.com" not in url:
      messagebox.showwarning(
          "Attention", "Veuillez entrer une URL GitHub valide."
      )
      return
    if not cat_id:
      messagebox.showwarning(
          "Attention", "Veuillez sélectionner une catégorie."
      )
      return

    self.data["repos"].append({"url": url, "categoryId": cat_id})
    self.refresh_repo_list()
    self.repo_url_entry.delete(0, tk.END)

  def update_repo(self):
    selected = self.repo_tree.selection()
    if not selected:
      messagebox.showwarning("Attention", "Sélectionnez un dépôt à modifier.")
      return
    item = self.repo_tree.item(selected)
    old_url = item["values"][0]

    new_url = self.repo_url_entry.get().strip()
    cat_id = self.repo_cat_combo.get().strip()

    for repo in self.data["repos"]:
      if repo["url"] == old_url:
        repo["url"] = new_url
        repo["categoryId"] = cat_id
        break

    self.refresh_repo_list()

  def delete_repo(self):
    selected = self.repo_tree.selection()
    if not selected:
      messagebox.showwarning("Attention", "Sélectionnez un dépôt à supprimer.")
      return
    item = self.repo_tree.item(selected)
    url = item["values"][0]

    if messagebox.askyesno(
        "Confirmation", f"Supprimer le dépôt :\n{url} ?"
    ):
      self.data["repos"] = [r for r in self.data["repos"] if r["url"] != url]
      self.refresh_repo_list()

  def on_repo_select(self, event):
    selected = self.repo_tree.selection()
    if selected:
      item = self.repo_tree.item(selected)
      values = item["values"]
      self.repo_url_entry.delete(0, tk.END)
      self.repo_url_entry.insert(0, values[0])
      self.repo_cat_combo.set(values[1])

  def clear_repo_form(self):
    self.repo_url_entry.delete(0, tk.END)


if __name__ == "__main__":
  root = tk.Tk()
  app = ConfigManagerApp(root)
  root.mainloop()
